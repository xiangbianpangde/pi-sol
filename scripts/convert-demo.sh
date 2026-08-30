#!/usr/bin/env bash
# Convert screen recording (.mov or .mp4) to high-quality GIF, WebP, and MP4.
# Usage: ./scripts/convert-demo.sh <input_file> [output_base_name]
set -euo pipefail

INPUT="${1:-}"
if [[ -z "$INPUT" || ! -f "$INPUT" ]]; then
  echo "Usage: $0 <input_video_path> [output_base_name]"
  echo "Example: $0 ~/Desktop/recording.mov demo"
  exit 1
fi

OUTPUT_DIR="$(cd "$(dirname "$0")/../docs/images" && pwd)"
mkdir -p "$OUTPUT_DIR"

BASE_NAME="${2:-demo}"
GIF_OUT="$OUTPUT_DIR/${BASE_NAME}.gif"
MP4_OUT="$OUTPUT_DIR/${BASE_NAME}.mp4"
WEBP_OUT="$OUTPUT_DIR/${BASE_NAME}.webp"

echo "==> Converting '$INPUT' to optimized media in $OUTPUT_DIR..."

# 1. Generate optimized MP4 (H.264, Web compatible, no audio)
echo "--> Generating web-ready MP4: $MP4_OUT"
ffmpeg -y -i "$INPUT" -vcodec libx264 -crf 22 -preset medium -pix_fmt yuv420p -an -movflags +faststart "$MP4_OUT"

# 2. Generate high-quality Palette-optimized GIF (15 fps, max 960px width)
echo "--> Generating palette-optimized GIF: $GIF_OUT"
ffmpeg -y -i "$INPUT" -vf "fps=15,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "$GIF_OUT"

# 3. Generate animated WebP (often smaller and smoother than GIF)
echo "--> Generating animated WebP: $WEBP_OUT"
ffmpeg -y -i "$INPUT" -vcodec libwebp -lossless 0 -compression_level 4 -q:v 70 -loop 0 -an -vsync 0 "$WEBP_OUT"

echo "==> Done! Generated files:"
ls -lh "$GIF_OUT" "$MP4_OUT" "$WEBP_OUT"
