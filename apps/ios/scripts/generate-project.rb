# Run from any directory with Ruby and the xcodeproj gem installed.
require 'xcodeproj'
require 'json'
require 'fileutils'
require 'open3'
root = File.expand_path('..', __dir__)
profile = JSON.parse(File.read(File.join(root, '../../packages/contracts/src/deployment-profiles.json')))['production']
project = Xcodeproj::Project.new(File.join(root, 'Zuse.xcodeproj'))
target = project.new_target(:application, 'Zuse', :ios, '18.0')
group = project.main_group.new_group('App', 'App')
Dir.glob(File.join(root, 'App/*.swift')).sort.each do |file|
  target.source_build_phase.add_file_reference(group.new_file(File.basename(file)))
end
FileUtils.cp(File.join(root, '../web/public/models/v1.json'), File.join(root, 'App/ModelCatalog.json'))
target.resources_build_phase.add_file_reference(group.new_file('ModelCatalog.json'))
unless system('bun', 'build', File.join(root, 'scripts/ui-parser.ts'), '--target=browser', '--format=iife', '--outfile=' + File.join(root, 'App/UIParser.js'))
  abort 'Could not generate the shared UI parser.'
end
target.resources_build_phase.add_file_reference(group.new_file('UIParser.js'))
target.resources_build_phase.add_file_reference(group.new_file('Assets.xcassets'))
mermaid_entry, mermaid_status = Open3.capture2('bun', '-e', 'console.log(Bun.resolveSync("mermaid", process.argv[1]))', File.join(root, '../renderer'))
abort 'Install workspace dependencies before generating diagram resources.' unless mermaid_status.success?
mermaid_dist = File.dirname(mermaid_entry.strip)
FileUtils.cp(File.join(mermaid_dist, 'mermaid.min.js'), File.join(root, 'App/Mermaid.js'))
FileUtils.cp(File.join(mermaid_dist, '../LICENSE'), File.join(root, 'App/Mermaid-LICENSE.txt'))
['Diagram.html', 'Mermaid.js', 'Mermaid-LICENSE.txt', 'ThirdPartyNotices.txt'].each do |resource|
  target.resources_build_phase.add_file_reference(group.new_file(resource))
end
core = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
core.relative_path = '.'
project.root_object.package_references << core
textual = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
textual.repositoryURL = 'https://github.com/gonzalezreal/textual.git'
textual.requirement = { 'kind' => 'exactVersion', 'version' => '0.5.0' }
project.root_object.package_references << textual
[['ZuseCore', core], ['Textual', textual]].each do |name, package|
  product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  product.product_name = name
  product.package = package
  target.package_product_dependencies << product
  build = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  build.product_ref = product
  target.frameworks_build_phase.files << build
end
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'sh.zuse.native',
    'PRODUCT_NAME' => 'Zuse Native',
    'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
    'SWIFT_VERSION' => '6.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'SUPPORTS_MACCATALYST' => 'NO',
    'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD' => 'NO',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'INFOPLIST_FILE' => 'App/Info.plist',
    'CODE_SIGN_STYLE' => 'Automatic',
    'CURRENT_PROJECT_VERSION' => '1',
    'MARKETING_VERSION' => '0.1.0'
  })
end
Xcodeproj::Plist.write_to_path({
  'CFBundleDisplayName' => 'Zuse Native',
  'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)',
  'CFBundleExecutable' => '$(EXECUTABLE_NAME)',
  'CFBundleName' => '$(PRODUCT_NAME)',
  'CFBundlePackageType' => 'APPL',
  'CFBundleShortVersionString' => '$(MARKETING_VERSION)',
  'CFBundleVersion' => '$(CURRENT_PROJECT_VERSION)',
  'LSRequiresIPhoneOS' => true,
  'UILaunchScreen' => {},
  'NSCameraUsageDescription' => 'Scan a pairing QR code to connect to your computer.',
  'NSLocalNetworkUsageDescription' => 'Find and connect to your Zuse computer on the local network.',
  'NSBonjourServices' => ['_zuse._tcp'],
  'NSAppTransportSecurity' => { 'NSAllowsLocalNetworking' => true },
  'UIApplicationSceneManifest' => { 'UIApplicationSupportsMultipleScenes' => false },
  'UISupportedInterfaceOrientations' => ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  'UISupportedInterfaceOrientations~ipad' => ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  'CFBundleURLTypes' => [{ 'CFBundleURLSchemes' => ['zuse-native'] }],
  'WorkOSClientID' => profile['workosPublicClientId'],
  'ZuseAPIURL' => profile['apiUrl']
}, File.join(root, 'App/Info.plist'))
ui_tests = project.new_target(:ui_test_bundle, 'ZuseUITests', :ios, '18.0')
ui_tests.add_dependency(target)
test_group = project.main_group.new_group('UITests', 'UITests')
Dir.glob(File.join(root, 'UITests/*.swift')).sort.each do |file|
  ui_tests.source_build_phase.add_file_reference(test_group.new_file(File.basename(file)))
end
ui_tests.build_configurations.each do |config|
  config.build_settings.merge!({ 'PRODUCT_BUNDLE_IDENTIFIER' => 'sh.zuse.native.uitests', 'SWIFT_VERSION' => '6.0', 'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_TARGET_NAME' => 'Zuse', 'TARGETED_DEVICE_FAMILY' => '1,2' })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.set_launch_target(target)
scheme.add_test_target(ui_tests)
scheme.save_as(project.path, 'Zuse', true)
