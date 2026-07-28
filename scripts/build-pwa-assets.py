from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "apps" / "web" / "assets"
SOURCE = ASSETS / "pwa-violet-icon-source.png"


def resample_icon(source: Image.Image, size: int, filename: str) -> None:
    source.resize((size, size), Image.Resampling.LANCZOS).save(
        ASSETS / filename,
        optimize=True,
    )


def font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path("C:/Windows/Fonts/bahnschrift.ttf"),
        Path("C:/Windows/Fonts/consolab.ttf"),
        Path("C:/Windows/Fonts/consola.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def centered_text(
    canvas: Image.Image,
    text: str,
    y: int,
    text_font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
) -> None:
    draw = ImageDraw.Draw(canvas)
    box = draw.textbbox((0, 0), text, font=text_font)
    x = (canvas.width - (box[2] - box[0])) // 2
    draw.text((x, y), text, font=text_font, fill=fill)


def build_splash(icon: Image.Image, width: int, height: int, filename: str) -> None:
    canvas = Image.new("RGBA", (width, height), (3, 1, 8, 255))
    pixels = canvas.load()
    for y in range(height):
        vertical = y / max(height - 1, 1)
        for x in range(width):
            dx = (x - width * 0.5) / width
            dy = (y - height * 0.34) / height
            violet = max(0.0, 1.0 - (dx * dx * 8.5 + dy * dy * 5.0))
            green = max(0.0, 1.0 - (dx * dx * 15.0 + ((y - height * 0.65) / height) ** 2 * 18.0))
            pixels[x, y] = (
                int(3 + violet * 20),
                int(1 + violet * 7 + green * 5),
                int(8 + violet * 38 + green * 9),
                255,
            )

    grid = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    spacing = max(52, width // 18)
    for x in range(0, width, spacing):
        grid_draw.line((x, 0, x, height), fill=(150, 88, 255, 15), width=1)
    for y in range(0, height, spacing):
        grid_draw.line((0, y, width, y), fill=(150, 88, 255, 12), width=1)
    canvas = Image.alpha_composite(canvas, grid)

    icon_size = int(width * 0.58)
    icon_render = icon.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    icon_x = (width - icon_size) // 2
    icon_y = int(height * 0.23)

    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.rounded_rectangle(
        (
            icon_x + int(icon_size * 0.08),
            icon_y + int(icon_size * 0.08),
            icon_x + int(icon_size * 0.92),
            icon_y + int(icon_size * 0.92),
        ),
        radius=icon_size // 4,
        fill=(139, 65, 255, 150),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(icon_size // 7))
    canvas = Image.alpha_composite(canvas, glow)
    canvas.alpha_composite(icon_render, (icon_x, icon_y))

    title_y = icon_y + icon_size + int(height * 0.055)
    centered_text(canvas, "HERMES CONTROL", title_y, font(int(width * 0.073)), (239, 225, 255, 255))
    centered_text(
        canvas,
        "CODEX  +  HERMES",
        title_y + int(width * 0.105),
        font(int(width * 0.031)),
        (187, 151, 255, 230),
    )

    status_y = title_y + int(width * 0.19)
    status = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    status_draw = ImageDraw.Draw(status)
    status_draw.rounded_rectangle(
        (int(width * 0.31), status_y, int(width * 0.69), status_y + int(width * 0.075)),
        radius=int(width * 0.04),
        outline=(40, 255, 157, 190),
        width=max(2, width // 300),
        fill=(2, 15, 13, 205),
    )
    status_draw.ellipse(
        (
            int(width * 0.355),
            status_y + int(width * 0.025),
            int(width * 0.375),
            status_y + int(width * 0.045),
        ),
        fill=(44, 255, 158, 255),
    )
    canvas = Image.alpha_composite(canvas, status)
    centered_text(
        canvas,
        "LINKING",
        status_y + int(width * 0.018),
        font(int(width * 0.027)),
        (61, 255, 170, 255),
    )

    canvas.convert("RGB").save(ASSETS / filename, optimize=True, quality=94)


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    resample_icon(source, 1024, "pwa-violet-v2-icon-1024.png")
    resample_icon(source, 512, "pwa-violet-v2-icon-512.png")
    resample_icon(source, 192, "pwa-violet-v2-icon-192.png")
    resample_icon(source, 180, "pwa-violet-v2-icon-180.png")
    build_splash(source, 1206, 2622, "pwa-violet-v2-splash-1206x2622.png")
    build_splash(source, 1179, 2556, "pwa-violet-v2-splash-1179x2556.png")


if __name__ == "__main__":
    main()
