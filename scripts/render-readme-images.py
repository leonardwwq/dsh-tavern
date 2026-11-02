"""Render the paired README concept illustrations (not application screenshots).
Requires Pillow and a Chinese font. Run from the sibling-project workspace.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

ROOT = Path(__file__).resolve().parents[2]
W, H, SCALE = 1600, 940, 2
FONT = '/System/Library/Fonts/PingFang.ttc'
C = {'bg': '#141b28', 'panel': '#202b3b', 'line': '#3a485d', 'text': '#f4f2eb',
     'muted': '#b2bfd0', 'mint': '#88e0c3', 'gold': '#ffbc91', 'lilac': '#b9aff5'}

def rgb(h):
    return tuple(int(h[i:i+2], 16) for i in (1, 3, 5))

class Art:
    def __init__(self, brand, accent):
        self.im = Image.new('RGB', (W*SCALE, H*SCALE))
        self.d = ImageDraw.Draw(self.im)
        a, b = rgb('#111724'), rgb('#202d3b')
        for y in range(H*SCALE):
            t = y/(H*SCALE)
            self.d.line((0,y,W*SCALE,y), fill=tuple(int(a[i]*(1-t)+b[i]*t) for i in range(3)))
        self.accent = accent
        self.round((30,30,1570,910),22,None,C['line'])
        self.round((70,58,108,96),10,accent)
        self.text((82,64),'D',23,C['bg'])
        self.text((124,58),brand,27,C['text'])
        self.text((1195,66),'PRODUCT CONCEPT',19,C['muted'])
        self.line((72,860,1528,860),C['line'])
        self.text((72,883),'DSH / AI-NATIVE PRODUCT DESIGN',17,C['muted'])
        self.text((1150,880),'产品设计示意 · 非实际界面截图',17,C['muted'])

    def box(self, p): return tuple(int(v*SCALE) for v in p)
    def text(self, p, text, size=24, color=None):
        f=ImageFont.truetype(FONT,int(size*SCALE))
        self.d.text(self.box(p),text,font=f,fill=color or C['text'])
    def round(self,p,r=18,fill=None,outline=None,width=1):
        self.d.rounded_rectangle(self.box(p),r*SCALE,fill=fill,outline=outline,width=width*SCALE)
    def line(self,p,fill=None,width=2): self.d.line(self.box(p),fill=fill or C['line'],width=width*SCALE)
    def circle(self,p,fill,outline=None,width=1): self.d.ellipse(self.box(p),fill=fill,outline=outline,width=width*SCALE)
    def arrow(self,p,color=None):
        color=color or self.accent
        self.line(p,color,2)
        x1,y1,x2,y2=p
        a=math.atan2(y2-y1,x2-x1)
        pts=[(x2,y2),(x2-11*math.cos(a-.5),y2-11*math.sin(a-.5)),(x2-11*math.cos(a+.5),y2-11*math.sin(a+.5))]
        self.d.polygon([self.box(pt) for pt in pts],fill=color)
    def note(self,y,n,title,detail):
        self.round((72,y,118,y+44),12,self.accent)
        self.text((83,y+5),n,21,C['bg'])
        self.text((136,y-4),title,27)
        self.text((136,y+34),detail,20,C['muted'])
    def save(self,p):
        p.parent.mkdir(parents=True,exist_ok=True)
        self.im.resize((W,H),Image.Resampling.LANCZOS).save(p,optimize=True)
        print(p)

def tavern():
    a=Art('DSH TAVERN',C['mint'])
    a.text((72,145),'GENERATIVE ADVENTURE',18,C['mint'])
    a.text((68,196),'把一句话，',65)
    a.text((68,280),'变成一场冒险。',65)
    a.text((74,392),'自由表达，故事承接。',28,C['muted'])
    a.text((74,438),'让人物带着记忆继续同行。',25,C['muted'])
    a.note(548,'01','说出行动','不猜句式，不走审批')
    a.note(642,'02','得到回应','让过程发生，让选择有后果')
    a.note(736,'03','积累经历','人物各自记住，再进入下一轮')
    a.round((620,160,970,278),20,C['panel'],C['line'])
    a.text((644,180),'PLAYER / 玩家表达',18,C['mint'])
    a.text((644,215),'自然语言表达意图',29)
    a.arrow((987,219,1090,219))
    a.round((1108,160,1500,278),20,C['panel'],C['mint'])
    a.text((1132,180),'LLM HOST / 统一主持',18,C['mint'])
    a.text((1132,220),'理解上下文，承接后果',26)
    a.arrow((1304,290,1304,329))
    a.round((620,344,1500,518),20,'#263648',C['line'])
    a.text((646,366),'STORY IN MOTION / 动态叙事',18,C['gold'])
    a.text((646,414),'意图被理解，世界作出回应。',31)
    a.text((646,459),'情境变化 · 人物行动 · 选择后果',29)
    for x,num,name,role,color in [(620,'01','人物动机','目标 · 性格 · 立场',C['mint']),(920,'02','关系互动','回应 · 冲突 · 合作',C['gold']),(1220,'03','行动反馈','行为 · 后果 · 变化',C['lilac'])]:
        a.round((x,554,x+280,714),18,C['panel'],C['line'])
        a.circle((x+22,578,x+66,622),'#34445a')
        a.text((x+32,586),num,18,color)
        a.text((x+81,580),name,28)
        a.text((x+24,650),role,21,C['muted'])
    a.arrow((1060,727,1060,754))
    a.round((620,768,1500,829),17,'#263d40')
    a.text((644,783),'记录已发生的事',24,C['mint'])
    a.arrow((870,800,943,800),C['mint'])
    a.text((968,783),'积累各自的经历',24,C['mint'])
    a.text((1233,788),'供后续主持读取',18,C['muted'])
    a.save(ROOT/'dsh-tavern/docs/images/tavern-overview.png')

def cultivation():
    a=Art('CHARACTER CULTIVATION',C['lilac'])
    a.text((72,145),'PERSISTENT CHARACTER',18,C['lilac'])
    a.text((68,196),'不只记得你，',65)
    a.text((68,280),'更逐渐认识你。',65)
    a.text((74,392),'人设是起点，相处才是内容。',27,C['muted'])
    a.text((74,438),'让每次互动，都有共同经历作依据。',23,C['muted'])
    a.note(548,'01','记得经历','把值得保留的事留下来')
    a.note(642,'02','保留判断','不同角色，形成不同的认识')
    a.note(736,'03','延续相处','让积累参与下一次回应')
    a.round((866,151,1254,292),22,C['panel'],C['lilac'])
    a.circle((892,181,966,255),'#3a3659')
    a.circle((917,191,941,215),C['lilac'])
    a.round((908,224,950,245),12,C['lilac'])
    a.text((992,174),'PERSONA / 人物',18,C['lilac'])
    a.text((992,216),'独立人设 × 共同经历',24)
    a.line((1060,306,1060,333),C['lilac'])
    a.line((763,333,1363,333),C['line'])
    for x,title,en,color,lines,label in [
        (633,'记忆','MEMORY',C['mint'],['“你说过，','周末想安静一点。”'],'记住发生过的事'),
        (933,'认识','BELIEF',C['gold'],['“你可能更重视','自己的个人空间。”'],'形成可修正的判断'),
        (1233,'成长','GROWTH',C['lilac'],['“关心你，也学着','给你留一点空间。”'],'成长方向示意')]:
        a.arrow((x+130,333,x+130,365),color)
        a.round((x,384,x+267,691),20,C['panel'],C['line'])
        a.round((x+24,409,x+73,415),3,color)
        a.text((x+24,438),title,41)
        a.text((x+24,495),en,17,color)
        for i,line in enumerate(lines):a.text((x+24,551+i*34),line,22,C['text'])
        a.text((x+24,645),label,18,C['muted'])
    a.round((633,741,1500,829),19,'#302e47')
    a.text((662,757),'共同经历 → 角色视角 → 持续积累 → 下一次回应',25,C['lilac'])
    a.text((662,796),'让记忆不只被保存，也重新进入相处。',18,C['muted'])
    a.save(ROOT/'dsh-cultivation/docs/images/cultivation-product.png')

if __name__=='__main__':
    tavern()
    cultivation()
