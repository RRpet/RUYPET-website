"""Deterministic, synthetic algorithm fixtures. NOT user/dog photographs."""
from PIL import Image, ImageDraw, ImageCms, ImageOps
from pathlib import Path
import math
root=Path(__file__).parent
w,h=600,800
im=Image.new('RGB',(w,h));p=im.load()
for y in range(h):
    for x in range(w):
        v=round(213+25*x/(w-1)+6*y/(h-1))
        p[x,y]=(v,min(255,v+3),min(255,v+7))
d=ImageDraw.Draw(im)
d.ellipse((150,650,460,730),fill=(125,128,132)) # contact-shadow control
d.rectangle((190,200,400,650),fill=(150,55,40)) # product-color control
d.rectangle((230,240,360,500),fill=(20,25,32))
for y in range(260,470,12):
    d.line((240,y,350,y+10),fill=(200,200,200),width=1) # fine-detail control
for x in range(180,410,5):
    d.line((x,200,x-10,180-(x%7)),fill=(70,60,50),width=1) # fine-edge control
for x in range(420,480):
    for y in range(350,550):
        old=p[x,y];a=.25 if (x+y)%7 else .6
        p[x,y]=tuple(round(v*(1-a)+25*a) for v in old) # translucent-material control
im.save(root/'synthetic-studio.png')
im.save(root/'synthetic-studio.webp',lossless=True)
profile=ImageCms.ImageCmsProfile('/usr/share/color/icc/compatibleWithAdobeRGB1998.icc')
src=Image.new('RGB',(120,80),(130,80,50));dd=ImageDraw.Draw(src);dd.rectangle((60,0,119,39),fill=(30,140,70));dd.rectangle((0,40,59,79),fill=(40,60,150))
exif=Image.Exif();exif[274]=6
src.save(root/'adobe-rgb-orientation-6.jpg',quality=100,subsampling=0,icc_profile=profile.tobytes(),exif=exif)
reopened=Image.open(root/'adobe-rgb-orientation-6.jpg')
expected=ImageCms.profileToProfile(ImageOps.exif_transpose(reopened),profile,ImageCms.createProfile('sRGB'),outputMode='RGB')
expected.save(root/'adobe-rgb-expected-srgb.png')
