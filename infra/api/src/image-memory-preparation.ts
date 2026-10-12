/**
 * Image-build only. E2B restores memory lazily: stale contents in free pages can
 * make a new Node heap fault in megabytes of discarded installer/runtime data.
 * Clear reusable pages, leave 1 GiB of headroom, then warm read-only runtime
 * files without starting another Node heap. Never run on an enrolled workspace.
 */
export const IMAGE_MEMORY_PREPARATION_SCRIPT = `python3 - <<'ZUSE_IMAGE_MEMORY'
import mmap
import os

os.sync()
with open('/proc/sys/vm/drop_caches', 'w') as cache_control:
    cache_control.write('3')
with open('/proc/meminfo') as info:
    memory = {key: int(value.split()[0]) for key, value in
              (line.split(':', 1) for line in info)}
size = max(0, memory['MemAvailable'] * 1024 - 1024 * 1024 * 1024)
if size:
    with mmap.mmap(-1, size) as pages:
        block = bytes(8 * 1024 * 1024)
        for offset in range(0, size, len(block)):
            pages.write(block[:min(len(block), size - offset)])
print('Prepared snapshot memory bytes:', size)
os.sync()
ZUSE_IMAGE_MEMORY
# Read the installed agent packages, including their native executables. A
# version check touches too little of the app-server startup path. No agent
# process, account state, or random-number state survives image capture.
find -L /opt/zuse/toolchain-current/node_modules/@openai /opt/zuse/toolchain-current/node_modules/@anthropic-ai -type f -exec cat {} + >/dev/null
# The process supervisor starts before Node. Keep its standard-library imports
# resident too, then warm the runtime last so agent reads cannot evict it.
python3 -c 'import ctypes,os,signal,subprocess,sys,time'
cat "$(command -v node)" /opt/zuse/current/bin.mjs >/dev/null
find /opt/zuse/node-compile-cache -type f -exec cat {} + >/dev/null
`;
