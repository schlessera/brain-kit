"""Design-artifact generator only: explicit compositions, no product renderer/layout."""
from pathlib import Path
from html import escape
import json, math

HERE = Path(__file__).parent
TOKENS = {
    'light': dict(bg='#f8f5ef', node='#fffefa', cluster='#ece7dc', line='#5f584c', border='#847c6f', text='#231f1a', mute='#5f584c', focal='#fbf1e0', amber='#7f4c08', blue='#1a5c7f', frame='#ddd6c7', focus='#231f1a'),
    'dark': dict(bg='#141619', node='#1e2128', cluster='#0c0e12', line='#9a96a1', border='#6b6873', text='#e8e4df', mute='#9a96a1', focal='#3d352c', amber='#e09f3e', blue='#67b8e3', frame='#1f2229', focus='#e8e4df'),
    'print': dict(bg='#ffffff', node='#ffffff', cluster='#ffffff', line='#5f584c', border='#847c6f', text='#231f1a', mute='#5f584c', focal='#ffffff', amber='#7f4c08', blue='#1a5c7f', frame='#cbc3b2', focus='#231f1a'),
}
NAMES = dict(bg='diagram-bg', node='diagram-node', cluster='diagram-cluster', line='diagram-line', border='diagram-cluster-border', text='diagram-text', mute='color-ink-mute', focal='diagram-focal-tint', amber='amber-ink', blue='blue-ink', frame='color-line', focus='focus-ring')
NODES = [
    ('phone', "Odysseus's phone", 'capture, 06:40', 'input', 'INPUT'),
    ('news', 'News from Sparta', 'Telemachus', 'external', 'EXTERNAL'),
    ('source-watch', 'source-watch', 'watches Sparta', 'default', 'AGENT'),
    ('inbox', 'Inbox', 'inbox/', 'store', 'STORE'),
    ('note-filer', 'note-filer', 'files each note', 'focal', 'AGENT'),
    ('crew', 'Crew ledger', 'crew/ledger.md', 'store', 'STORE'),
    ('voyage', 'Voyage notes', 'voyage/', 'store', 'STORE'),
    ('penelope', 'Penelope', 'Ithaca, +1 h', 'external', 'EXTERNAL'),
]
EDGES = [
    ('capture', 'phone', 'inbox', 'primary', 'CAPTURE'),
    ('watch', 'news', 'source-watch', 'async', 'WATCH'),
    ('deliver', 'source-watch', 'inbox', 'default', 'DELIVER'),
    ('intake', 'inbox', 'note-filer', 'default', ''),
    ('ledger', 'note-filer', 'crew', 'default', 'LEDGER'),
    ('file', 'note-filer', 'voyage', 'default', 'FILE'),
    ('digest', 'note-filer', 'penelope', 'link', 'DIGEST'),
]
GROUPS = [('ogygia', 'OGYGIA', ['phone']), ('brain', 'THE BRAIN', ['source-watch', 'inbox', 'note-filer', 'crew', 'voyage']), ('ithaca', 'ITHACA', ['penelope'])]
LAYOUTS = {
 'desktop': dict(width=720, height=480,
  boxes={'phone':[32,88,136,64], 'news':[32,208,136,64], 'source-watch':[232,208,112,64], 'inbox':[232,88,112,64], 'note-filer':[400,88,128,64], 'crew':[248,312,128,64], 'voyage':[400,312,128,64], 'penelope':[588,88,104,64]},
  groups={'ogygia':[16,48,168,128], 'brain':[216,48,328,352], 'ithaca':[576,48,128,128]},
  routes={'capture':[[168,120],[232,120]], 'watch':[[168,240],[232,240]], 'deliver':[[288,208],[288,152]], 'intake':[[344,120],[400,120]], 'ledger':[[400+128/3,152],[400+128/3,288],[312,288],[312,312]], 'file':[[400+256/3,152],[400+256/3,280],[464,280],[464,312]], 'digest':[[528,120],[588,120]]},
  labels={'capture':[200,106,'bg'], 'watch':[200,226,'bg'], 'deliver':[324,180,'cluster'], 'ledger':[410,248,'cluster'], 'file':[512,216,'cluster'], 'digest':[558,106,'bg']}, legend=432),
 'narrow': dict(width=320, height=1088,
  boxes={'phone':[40,56,240,64], 'news':[40,176,240,64], 'source-watch':[40,312,240,64], 'inbox':[40,432,240,64], 'note-filer':[40,552,240,64], 'crew':[40,712,112,64], 'voyage':[168,712,112,64], 'penelope':[40,880,240,64]},
  groups={'ogygia':[16,32,288,112], 'brain':[16,288,288,520], 'ithaca':[16,856,288,112]},
  routes={'capture':[[280,88],[296,88],[296,464],[280,464]], 'watch':[[160,240],[160,312]], 'deliver':[[160,376],[160,432]], 'intake':[[160,496],[160,552]], 'ledger':[[120,616],[120,656],[96,656],[96,712]], 'file':[[200,616],[200,680],[224,680],[224,712]], 'digest':[[280,584],[296,584],[296,912],[280,912]]},
  labels={'capture':[261,264,'bg'], 'watch':[190,272,'bg'], 'deliver':[196,404,'cluster'], 'ledger':[88,640,'cluster'], 'file':[226,652,'cluster'], 'digest':[263,832,'bg']}, legend=992),
}

def var(name): return 'var(--bk-'+NAMES[name]+')'
def attrs(**items): return ' '.join(k.replace('_','-')+'="'+escape(str(v),quote=True)+'"' for k,v in items.items())
def element(tag, **items): return '<'+tag+' '+attrs(**items)+'/>'
def text(x,y,value,kind='tag',ink='mute',**extra):
    family, size, weight = ("'Plus Jakarta Sans', system-ui, sans-serif",12,600) if kind=='name' else ("'JetBrains Mono', ui-monospace, monospace",10,400) if kind=='sub' else ("'DM Serif Text', Georgia, serif",18,400) if kind=='title' else ("'JetBrains Mono', ui-monospace, monospace",9.5,600)
    values = dict(x=x,y=y,font_family=family,font_size=size,font_weight=weight,fill=var(ink),**extra)
    if kind=='tag': values['letter_spacing']=.855
    return '<text '+attrs(**values)+'>'+escape(value)+'</text>'
def rect(box, fill, stroke='line', width=1, radius=5, **extra):
    x,y,w,h=box
    return element('rect',x=x+width/2,y=y+width/2,width=w-width,height=h-width,rx=radius,fill=var(fill),stroke=var(stroke),stroke_width=width,**extra)
def rounded(points):
    out=['M%g,%g'%tuple(points[0])]
    for i in range(1,len(points)-1):
        before, at, after = points[i-1:i+2]
        a=math.dist(before,at); b=math.dist(at,after); r=min(8,a/2,b/2)
        p=[at[j]+(before[j]-at[j])*r/a for j in (0,1)]
        q=[at[j]+(after[j]-at[j])*r/b for j in (0,1)]
        out.append('L%g,%g Q%g,%g %g,%g'%(*p,*at,*q))
    out.append('L%g,%g'%tuple(points[-1]));return ' '.join(out)
def edge(points,kind,ground='cluster',focused=False):
    ink='text' if kind=='primary' or focused and kind!='link' else 'blue' if kind=='link' else 'line'
    width=2 if focused else 1.5 if kind in ('primary','async') else 1
    endpoint=points[-1]; previous=points[-2]
    dx,dy=endpoint[0]-previous[0],endpoint[1]-previous[1];length=math.hypot(dx,dy);ux,uy=dx/length,dy/length
    tip=[endpoint[0]-ux,endpoint[1]-uy];base=[tip[0]-8*ux,tip[1]-8*uy]
    a=[base[0]-4*uy,base[1]+4*ux]; b=[base[0]+4*uy,base[1]-4*ux]
    path_points=[list(p) for p in points];path_points[-1]=base if kind in ('primary','link') else tip
    style=dict(fill='none',stroke=var(ink),stroke_width=width)
    if kind=='async':style.update(stroke_dasharray='1.5 3.5',stroke_linecap='round')
    result=element('path',d=rounded(path_points),**style)
    if kind in ('primary','link'):
        result+=element('polygon',points=' '.join('%g,%g'%tuple(p)for p in (a,tip,b)),fill=var(ink if kind=='primary' else ground),stroke=var(ink),stroke_width=width)
    else:result+=element('polyline',points=' '.join('%g,%g'%tuple(p)for p in (a,tip,b)),fill='none',stroke=var(ink),stroke_width=width,stroke_linejoin='miter')
    return result

def mask(label,cx,cy,ground,ink):
    width=math.ceil(len(label)*6.6+8)
    return element('rect',x=cx-width/2,y=cy-7,width=width,height=14,fill=var(ground))+text(cx,cy+3.4,label,ink=ink,text_anchor='middle')
def legend(layout):
    y=layout['legend'];w=layout['width'];out=element('line',x1=16,y1=y,x2=w-16,y2=y,stroke=var('frame'))
    items=['PRIMARY','DEFAULT','ASYNC','LINK','FOCAL','STORE']
    for i,label in enumerate(items):
        x=(16+i*94) if w>320 else 24+(i%2)*144
        row=y+24 if w>320 else y+24+(i//2)*24
        if i<4:out+=edge([[x,row],[x+24,row]],['primary','default','async','link'][i],ground='bg')
        elif i==4:out+=rect([x,row-5,24,10],'focal','amber',2,3)
        else:out+=rect([x,row-5,24,10],'node',radius=3)+element('line',x1=x+1,y1=row-2,x2=x+23,y2=row-2,stroke=var('line'))
        out+=text(x+32,row+3.4,label)
    return out

def figure(theme,which,focus=False):
    layout=LAYOUTS[which];p=TOKENS[theme];out=[];prefix=f'relay-{which}-{theme}'+('-focus'if focus else'')
    css=':root{'+''.join('--bk-'+NAMES[k]+':'+v+';'for k,v in p.items())+'}'
    out.append('<svg xmlns="http://www.w3.org/2000/svg" '+attrs(width=layout['width'],height=layout['height'],viewBox=f"0 0 {layout['width']} {layout['height']}",role='img',aria_labelledby=prefix+'-title '+prefix+'-description',data_layout=which,data_theme=theme)+'>')
    out+=[f'<title id="{prefix}-title">The homecoming relay</title>',f'<desc id="{prefix}-description">Eight nodes: Odysseus’s phone captures to the inbox; News from Sparta reaches source-watch, which delivers to the inbox. The inbox feeds note-filer, which updates the crew ledger and voyage notes and sends a digest to Penelope on Ithaca. 06:40 on Ogygia, 2026-07-12; Ithaca is one hour ahead.</desc>', '<style>'+css+'</style>']
    out.append(element('rect',width=layout['width'],height=layout['height'],fill=var('bg')))
    if theme!='print':out.append(rect([0,0,layout['width'],layout['height']],'bg','frame',1,8))
    for gid,label,members in GROUPS:
        box=layout['groups'][gid];x,y,_,_=box
        out.append('<g '+attrs(data_group=gid)+'>')
        out.append(rect(box,'cluster','border',1,8))
        out.append(mask(label,x+12+len(label)*6.6/2,y,'bg','mute'))
        out.append('</g>')
    for eid,source,target,kind,label in EDGES:
        touched=focus and 'note-filer' in (source,target)
        out.append('<g '+attrs(data_edge=eid,data_from=source,data_to=target,data_kind=kind)+'>')
        out.append(edge(layout['routes'][eid],kind,'cluster',touched))
        if label:
            cx,cy,ground=layout['labels'][eid];out.append(mask(label,cx,cy,ground,'text'if kind=='primary'else'blue'if kind=='link'else'mute'))
        out.append('</g>')
    for nid,label,sub,role,tag in NODES:
        box=layout['boxes'][nid];x,y,w,h=box
        in_group=any(nid in members for _,_,members in GROUPS)
        fill='focal'if role=='focal'else'cluster'if role=='external'and in_group else'bg'if role=='external'else'node'
        out.append('<g '+attrs(data_node=nid,data_role=role)+'>')
        out.append(rect(box,fill,'amber'if role=='focal'else'line',2 if role=='focal'else 1))
        if role=='store':out.append(element('line',x1=x+1,y1=y+6.5,x2=x+w-1,y2=y+6.5,stroke=var('line')))
        out += [text(x+12,y+20,tag,ink='amber'if role=='focal'else'mute'),text(x+12,y+38,label,'name','text'),text(x+12,y+53,sub,'sub','text'if role=='focal'else'mute')]
        if focus and nid=='note-filer':out.append(element('rect',x=x-4,y=y-4,width=w+8,height=h+8,rx=9,fill='none',stroke=var('focus'),stroke_width=2,data_focus_ring='true'))
        out.append('</g>')
    out.append(legend(layout));out.append('</svg>');return '\n'.join(out)+'\n'

def validate():
    assert len(NODES)==8 and len(EDGES)==7 and sum(n[3]=='focal'for n in NODES)==1
    ids={n[0]for n in NODES}
    for name,layout in LAYOUTS.items():
        assert set(layout['boxes'])==ids
        for box in layout['boxes'].values():assert all(v%4==0 for v in box)
        for eid,source,target,kind,label in EDGES:
            points=layout['routes'][eid]
            for a,b in zip(points,points[1:]):
                assert (a[0]==b[0]) != (a[1]==b[1]),(name,eid,'nonorthogonal')
                for nid,(x,y,w,h)in layout['boxes'].items():
                    if nid in (source,target):continue
                    crosses=(a[0]==b[0]and x<a[0]<x+w and max(min(a[1],b[1]),y)<min(max(a[1],b[1]),y+h))or(a[1]==b[1]and y<a[1]<y+h and max(min(a[0],b[0]),x)<min(max(a[0],b[0]),x+w))
                    assert not crosses,(name,eid,'transit',nid)
            if label:
                cx,cy,_=layout['labels'][eid];mw=math.ceil(len(label)*6.6+8)
                for nid,(x,y,w,h)in layout['boxes'].items():
                    assert not(cx+mw/2>x and cx-mw/2<x+w and cy+7>y and cy-7<y+h),(name,eid,'mask overlaps',nid)
    return dict(nodes=8,relationships=7,focal_nodes=1,minimum_font_px=9.5,narrow_width_px=320,structural_grid_px=4,all_semantic_ids_preserved=True,orthogonal_routes=True,no_transit_behind_nodes=True,no_mask_node_overlap=True)

def luminance(color):
    channels=[int(color[i:i+2],16)/255 for i in(1,3,5)]
    r,g,b=[c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in channels]
    return .2126*r+.7152*g+.0722*b

def contrasts():
    pairs=[('focus','cluster',3),('border','cluster',3),('border','bg',3),('line','node',3),('line','cluster',3),('line','bg',3),('text','node',4.5),('text','bg',4.5),('text','cluster',4.5),('text','focal',4.5),('mute','node',4.5),('mute','cluster',4.5),('mute','bg',4.5),('amber','focal',4.5),('blue','bg',4.5),('blue','cluster',4.5)]
    report=[]
    for fg,bg,bar in pairs:
        row=dict(foreground='--bk-'+NAMES[fg],ground='--bk-'+NAMES[bg],minimum=bar,ratios={})
        for mode,p in TOKENS.items():
            a,b=sorted((luminance(p[fg]),luminance(p[bg])));ratio=(b+.05)/(a+.05)
            assert ratio>=bar,(mode,fg,bg,ratio)
            row['ratios'][mode]=round(ratio,2)
        report.append(row)
    return report

if __name__=='__main__':
    receipt=validate()
    for mode in TOKENS:
        for which in LAYOUTS:(HERE/f'relay-{which}-{mode}.svg').write_text(figure(mode,which))
    (HERE/'relay-desktop-focus-light.svg').write_text(figure('light','desktop',True))
    (HERE/'composition.json').write_text(json.dumps(dict(artifact_format='homecoming-design-layout-v1',nodes=NODES,edges=EDGES,groups=GROUPS,layouts=LAYOUTS),indent=2)+'\n')
    (HERE/'contrast.json').write_text(json.dumps(contrasts(),indent=2)+'\n')
    (HERE/'validation.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))
