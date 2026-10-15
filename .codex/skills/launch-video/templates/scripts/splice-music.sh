#!/usr/bin/env bash

set -euo pipefail
src=$1; out=$2; shift 2
filters=""; labels=""; total=0; i=0
for seg in "$@"; do
	a=${seg%-*}; b=${seg#*-}
	len=$(python3 -c "print($b - $a)")
	filters+="[0:a]atrim=$a:$b,asetpts=PTS-STARTPTS,afade=t=in:d=0.008,afade=t=out:st=$(python3 -c "print($len - 0.008)"):d=0.008[s$i];"
	labels+="[s$i]"; total=$(python3 -c "print($total + $len)"); i=$((i + 1))
done
ffmpeg -v error -y -i "$src" -filter_complex "${filters}${labels}concat=n=$i:v=0:a=1,afade=t=out:st=$(python3 -c "print($total - 1.2)"):d=1.2[o]" -map "[o]" -ar 48000 -ac 2 "$out"
echo "$out: ${total}s"
