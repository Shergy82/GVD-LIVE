import os
from PIL import Image, ImageDraw, ImageFont

public_dir = os.path.join(os.path.dirname(__file__), 'public')

def create_gvd_icon(size):
    img = Image.new('RGBA', (size, size), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Scale factor relative to 512
    scale = size / 512.0

    # Colors
    green = (58, 98, 65, 255)  # Dark forest green from logo
    black = (15, 23, 42, 255)  # Crisp dark charcoal/black

    # Draw top green roof/mountain graphic
    # Roof ridge shape: left point, peak, right point, inner cutout
    margin_x = int(50 * scale)
    top_y = int(80 * scale)
    peak_x = int(256 * scale)
    peak_y = int(140 * scale)
    bottom_y = int(230 * scale)

    # Draw green roof polygons/lines
    roof_points = [
        (margin_x + int(40 * scale), bottom_y),
        (margin_x + int(110 * scale), top_y + int(60 * scale)),
        (peak_x - int(20 * scale), top_y + int(20 * scale)),
        (peak_x, top_y),
        (peak_x + int(30 * scale), top_y + int(30 * scale)),
        (size - margin_x - int(80 * scale), top_y + int(100 * scale)),
        (size - margin_x - int(40 * scale), bottom_y - int(20 * scale)),
        (size - margin_x - int(20 * scale), bottom_y),
        (size - margin_x - int(40 * scale), bottom_y + int(10 * scale)),
        (peak_x + int(20 * scale), top_y + int(50 * scale)),
        (margin_x + int(80 * scale), bottom_y - int(10 * scale))
    ]
    draw.polygon(roof_points, fill=green)

    # Draw main text: GVD Contracts
    # Fallback to default sans font if custom font not found
    try:
        font_large = ImageFont.truetype("arialbd.ttf", int(68 * scale))
        font_small = ImageFont.truetype("arial.ttf", int(32 * scale))
    except:
        font_large = ImageFont.load_default()
        font_small = ImageFont.load_default()

    text_gvd = "GVD Contracts"
    bbox_gvd = draw.textbbox((0, 0), text_gvd, font=font_large)
    w_gvd = bbox_gvd[2] - bbox_gvd[0]
    x_gvd = (size - w_gvd) // 2
    y_gvd = int(255 * scale)
    draw.text((x_gvd, y_gvd), text_gvd, fill=black, font=font_large)

    # Draw bottom green bar
    bar_y = int(350 * scale)
    bar_x1 = margin_x + int(20 * scale)
    bar_x2 = size - margin_x - int(160 * scale)
    bar_h = int(14 * scale)
    draw.rectangle([bar_x1, bar_y, bar_x2, bar_y + bar_h], fill=green)

    # Draw subtext LIMITED
    text_lim = "LIMITED"
    bbox_lim = draw.textbbox((0, 0), text_lim, font=font_small)
    w_lim = bbox_lim[2] - bbox_lim[0]
    x_lim = size - margin_x - w_lim - int(20 * scale)
    y_lim = int(342 * scale)
    draw.text((x_lim, y_lim), text_lim, fill=black, font=font_small)

    return img

# Generate icons
icon_192 = create_gvd_icon(192)
icon_192.save(os.path.join(public_dir, 'icon-192.png'))

icon_512 = create_gvd_icon(512)
icon_512.save(os.path.join(public_dir, 'icon-512.png'))

apple_icon = create_gvd_icon(180)
apple_icon.save(os.path.join(public_dir, 'apple-touch-icon.png'))

logo_img = create_gvd_icon(300)
logo_img.save(os.path.join(public_dir, 'gvd-logo.png'))

print("GVD ICONS CREATED SUCCESSFULLY IN /public FOR HOMESCREEN & PWA!")
