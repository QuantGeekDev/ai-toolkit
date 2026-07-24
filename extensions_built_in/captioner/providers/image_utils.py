from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import os

from PIL import Image, ImageOps, UnidentifiedImageError

from .base import ProviderResponseError


@dataclass(frozen=True)
class PreparedImage:
    data: bytes
    mime_type: str
    width: int
    height: int


def _resize_to_pixels(image: Image.Image, max_pixels: int) -> Image.Image:
    pixels = image.width * image.height
    if pixels <= max_pixels:
        return image
    scale = (max_pixels / pixels) ** 0.5
    size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
    while size[0] * size[1] > max_pixels:
        size = (max(1, size[0] - 1), max(1, size[1] - 1))
    return image.resize(size, Image.Resampling.LANCZOS)


def prepare_image(
    file_path: str,
    *,
    max_pixels: int = 4_194_304,
    max_payload_bytes: int = 15 * 1024 * 1024,
) -> PreparedImage:
    if max_pixels < 65_536:
        raise ValueError("max_pixels must be at least 65536")
    if max_payload_bytes < 256 * 1024:
        raise ValueError("max_payload_bytes must be at least 262144")

    try:
        with Image.open(file_path) as source:
            source.load()
            image = ImageOps.exif_transpose(source)
            image = _resize_to_pixels(image, max_pixels)

            has_alpha = image.mode in ("RGBA", "LA") or (
                image.mode == "P" and "transparency" in image.info
            )
            if has_alpha:
                image = image.convert("RGBA")
                output_format = "PNG"
                mime_type = "image/png"
            else:
                image = image.convert("RGB")
                output_format = "JPEG"
                mime_type = "image/jpeg"

            quality = 92
            while True:
                buffer = BytesIO()
                save_kwargs = {"optimize": True}
                if output_format == "JPEG":
                    save_kwargs.update({"quality": quality, "progressive": True})
                image.save(buffer, format=output_format, **save_kwargs)
                data = buffer.getvalue()
                if len(data) <= max_payload_bytes:
                    return PreparedImage(data, mime_type, image.width, image.height)

                if output_format == "PNG":
                    # Large transparent images are flattened only when necessary to
                    # stay under the API payload limit.
                    background = Image.new("RGB", image.size, "white")
                    background.paste(image, mask=image.getchannel("A"))
                    image = background
                    output_format = "JPEG"
                    mime_type = "image/jpeg"
                    continue

                if quality > 70:
                    quality -= 10
                    continue

                if image.width <= 256 and image.height <= 256:
                    raise ProviderResponseError(
                        f"Image payload remains larger than {max_payload_bytes} bytes after resizing"
                    )
                image = image.resize(
                    (max(1, round(image.width * 0.8)), max(1, round(image.height * 0.8))),
                    Image.Resampling.LANCZOS,
                )
                quality = 85
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        name = os.path.basename(file_path)
        raise ProviderResponseError(f"Unable to read image {name}: {exc}") from exc
