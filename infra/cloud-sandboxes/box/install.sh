#!/usr/bin/env bash

set -euo pipefail

provision_dir="${ZUSE_PROVISION_DIR:-/tmp/zuse-provision}"

export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin

if ! command -v node >/dev/null 2>&1 || [ "$(node --version | cut -c2-3)" != "22" ]; then

	curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 https://deb.nodesource.com/setup_22.x -o /tmp/zuse-nodesource-setup.sh
	printf '%s  %s\n' '575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1' /tmp/zuse-nodesource-setup.sh | sha256sum --check --status
	bash /tmp/zuse-nodesource-setup.sh
	rm /tmp/zuse-nodesource-setup.sh
	apt-get install -y nodejs
fi

for launcher in pnpm pnpx yarn yarnpkg corepack bun bunx; do
	rm -f "/usr/local/bin/$launcher"
done

"$provision_dir/provision.sh" packages runtime-tools grok runtime layout

for agent in claude codex grok; do
	runuser -u zuse -- "$agent" --version
done

runuser -u zuse -- /usr/local/bin/zuse --help >/dev/null

gpasswd -d zuse sudo 2>/dev/null || true
gpasswd -d zuse admin 2>/dev/null || true
gpasswd -d zuse docker 2>/dev/null || true
printf 'zuse ALL=(ALL) !ALL\n' >/etc/sudoers.d/zuse-deny
chmod 0440 /etc/sudoers.d/zuse-deny

echo "zuse box template installation complete"
