// ── MODULE: export.js ── Vendetta World Map v4.00 ──────────────────────────
// ── EXPORT ────────────────────────────────────────────────────────────────────
function fileTimestamp(){
  const n=new Date();
  const pad=x=>String(x).padStart(2,'0');
  return `${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
}

function _exportPNGCore(scale, suffix){
  const cv=document.getElementById('map');
  const offscreen=document.createElement('canvas');
  offscreen.width=cv.width*scale;
  offscreen.height=cv.height*scale;
  const ctx=offscreen.getContext('2d');
  ctx.scale(scale,scale);
  ctx.drawImage(cv,0,0);

  // Draw player names at territory centroid (min 5 tiles, scale with zoom)
  const MIN_TILES=5;
  const cs=CELL*zoom;
  const fontSize=Math.max(8,Math.min(18,cs*0.7));
  ctx.font=`bold ${fontSize}px "Martian Mono",monospace`;
  ctx.textAlign='center';
  ctx.textBaseline='middle';

  // Group tiles by pid, compute centroid in screen coords
  const pidTiles=new Map();
  for(const t of tiles){
    if(!pidTiles.has(t.pid)) pidTiles.set(t.pid,[]);
    pidTiles.get(t.pid).push(t);
  }
  for(const [pid,pts] of pidTiles){
    if(pts.length<MIN_TILES) continue;
    const p=players.find(pl=>pl.pid===pid);
    if(!p||!p.name) continue;
    // Compute mean screen position
    let sx=0,sy=0;
    for(const t of pts){
      sx+=(t.x-minX)*cs+panX+cs/2;
      sy+=(maxY-t.y)*cs+panY+cs/2;
    }
    sx/=pts.length; sy/=pts.length;
    // Skip if centroid is off-screen
    if(sx<0||sx>cv.width||sy<0||sy>cv.height) continue;
    const name=p.name;
    const tw=ctx.measureText(name).width;
    // Dark background pill
    ctx.fillStyle='rgba(0,0,0,0.55)';
    ctx.beginPath();
    const pad=3,r=3;
    const bx=sx-tw/2-pad,by=sy-fontSize/2-pad,bw=tw+pad*2,bh=fontSize+pad*2;
    ctx.roundRect(bx,by,bw,bh,r);
    ctx.fill();
    // Text in player color
    ctx.fillStyle=markColor(pid,p.color);
    ctx.fillText(name,sx,sy);
  }

  const a=document.createElement('a');
  a.href=offscreen.toDataURL('image/png');
  a.download=`vendetta_map${suffix||''}_${fileTimestamp()}.png`;a.click();
}

function exportPNG(){ _exportPNGCore(3,''); }
function exportPNGHD(factor){ _exportPNGCore(3*factor,`_${factor}x`); }

async function exportGIF(){
  if(snapshots.length<2){alert('Need at least 2 snapshots to create an animation.');return;}

  const btn=document.getElementById('gifBtn');
  btn.disabled=true;

  const cv=document.getElementById('map');
  const W=cv.width, H=cv.height;
  const GW=Math.round(W/2), GH=Math.round(H/2);
  const frames=snapshots.slice(0,Math.min(20,snapshots.length)).reverse();

  const offscreen=document.createElement('canvas');
  offscreen.width=GW; offscreen.height=GH;
  const octx=offscreen.getContext('2d');

  // Collect raw pixel data per frame
  const framePixels=[];

  for(let i=0;i<frames.length;i++){
    const snap=frames[i];
    btn.textContent=`⏳ Frame ${i+1}/${frames.length}...`;
    await new Promise(r=>setTimeout(r,5));
    try{
      const d=await fetch(snap.file+'?t='+Date.now()).then(r=>r.json());
      const snapPlayers=d.players||[];
      octx.fillStyle='#080810';
      octx.fillRect(0,0,GW,GH);
      const cs=CELL*zoom*0.5;
      for(const t of (d.tiles||[])){
        const p=snapPlayers[t.p]; if(!p) continue;
        const isMe=MY_IDS.has(p.pid);
        const mark=getMark(p.pid);
        const col=mark==='friend'?'#1D9E75':mark==='enemy'?'#E24B4A':p.color;
        const sx=(t.x-minX)*cs+panX*0.5, sy=(maxY-t.y)*cs+panY*0.5;
        if(sx<-cs||sx>GW||sy<-cs||sy>GH) continue;
        octx.fillStyle=t.hq?(isMe?'#533AB7':'#6B1A1A'):col;
        octx.fillRect(sx+0.5,sy+0.5,Math.max(1,cs-1),Math.max(1,cs-1));
      }
      octx.fillStyle='rgba(0,0,0,0.6)';octx.fillRect(3,3,148,18);
      octx.fillStyle='rgba(255,255,255,0.85)';octx.font='11px sans-serif';
      octx.textAlign='left';octx.textBaseline='top';
      octx.fillText(snap.label,6,5);
      framePixels.push({pixels:octx.getImageData(0,0,GW,GH).data, label:snap.label});
    }catch(e){console.warn('Frame failed:',e);}
  }

  btn.textContent='⏳ Encoding...';
  await new Promise(r=>setTimeout(r,10));

  // Build GIF using inline encoder
  const gif=buildGIF(framePixels,GW,GH,70);
  const blob=new Blob([gif],{type:'image/gif'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`vendetta_map_${fileTimestamp()}.gif`;
  a.click();
  btn.disabled=false;btn.textContent='🎬 GIF';
}

// ── Minimal inline GIF encoder ────────────────────────────────────────────────
function buildGIF(frames,w,h,delay){
  // Quantize RGBA pixels to 256-color palette using median-cut approximation
  function quantize(rgba){
    const buckets=[[...Array(rgba.length/4).keys()]];
    while(buckets.length<256){
      let best=-1,bestRange=0;
      for(let i=0;i<buckets.length;i++){
        const b=buckets[i];
        let rMin=255,rMax=0,gMin=255,gMax=0,bMin=255,bMax=0;
        for(const p of b){
          const o=p*4;
          if(rgba[o]<rMin)rMin=rgba[o];if(rgba[o]>rMax)rMax=rgba[o];
          if(rgba[o+1]<gMin)gMin=rgba[o+1];if(rgba[o+1]>gMax)gMax=rgba[o+1];
          if(rgba[o+2]<bMin)bMin=rgba[o+2];if(rgba[o+2]>bMax)bMax=rgba[o+2];
        }
        const range=Math.max(rMax-rMin,gMax-gMin,bMax-bMin);
        if(range>bestRange){bestRange=range;best=i;}
      }
      if(best<0||bestRange===0) break;
      const b=buckets[best];
      let rMin=255,rMax=0,gMin=255,gMax=0,bMin=255,bMax=0;
      for(const p of b){
        const o=p*4;
        if(rgba[o]<rMin)rMin=rgba[o];if(rgba[o]>rMax)rMax=rgba[o];
        if(rgba[o+1]<gMin)gMin=rgba[o+1];if(rgba[o+1]>gMax)gMax=rgba[o+1];
        if(rgba[o+2]<bMin)bMin=rgba[o+2];if(rgba[o+2]>bMax)bMax=rgba[o+2];
      }
      const rRange=rMax-rMin,gRange=gMax-gMin,bRange=bMax-bMin;
      const ch=rRange>=gRange&&rRange>=bRange?0:gRange>=bRange?1:2;
      b.sort((a,z)=>rgba[a*4+ch]-rgba[z*4+ch]);
      const mid=b.length>>1;
      buckets.splice(best,1,b.slice(0,mid),b.slice(mid));
    }
    const palette=new Uint8Array(256*3);
    const map=new Map();
    buckets.forEach((b,i)=>{
      let r=0,g=0,bl=0;
      for(const p of b){const o=p*4;r+=rgba[o];g+=rgba[o+1];bl+=rgba[o+2];}
      palette[i*3]=r/b.length|0;palette[i*3+1]=g/b.length|0;palette[i*3+2]=bl/b.length|0;
      for(const p of b)map.set(p,i);
    });
    return{palette,map};
  }

  function nearestColor(r,g,b,palette){
    let best=0,bestD=1e9;
    for(let i=0;i<256;i++){
      const dr=r-palette[i*3],dg=g-palette[i*3+1],db=b-palette[i*3+2];
      const d=dr*dr+dg*dg+db*db;
      if(d<bestD){bestD=d;best=i;}
    }
    return best;
  }

  function lzwEncode(indices,minCode){
    const out=[];let buf=0,bits=0;
    const write=(v,n)=>{buf|=v<<bits;bits+=n;while(bits>=8){out.push(buf&255);buf>>=8;bits-=8;}};
    let codeSize=minCode+1,codeLimit=1<<codeSize;
    const clear=1<<minCode,eoi=clear+1;
    let table=new Map(),next=eoi+1;
    const resetTable=()=>{table.clear();next=eoi+1;codeSize=minCode+1;codeLimit=1<<codeSize;};
    write(clear,codeSize);resetTable();
    let buf2=indices[0];
    for(let i=1;i<indices.length;i++){
      const c=indices[i],key=buf2*4096+c;
      if(table.has(key)){buf2=table.get(key);}
      else{
        write(buf2,codeSize);
        if(next>=4096){write(clear,codeSize);resetTable();buf2=c;}
        else{table.set(key,next++);if(next>codeLimit&&codeSize<12){codeSize++;codeLimit<<=1;}buf2=c;}
      }
    }
    write(buf2,codeSize);write(eoi,codeSize);
    if(bits>0){out.push(buf&255);}
    return out;
  }

  function packSubBlocks(data){
    const out=[];
    for(let i=0;i<data.length;i+=255){
      const chunk=data.slice(i,i+255);
      out.push(chunk.length,...chunk);
    }
    out.push(0);return out;
  }

  // Use first frame's palette for all frames (global palette)
  const{palette}=quantize(frames[0].pixels);

  const bytes=[];
  const push=(...v)=>bytes.push(...v);
  const pushStr=(s)=>{for(let i=0;i<s.length;i++)push(s.charCodeAt(i));};
  const push16=(v)=>{push(v&255,(v>>8)&255);};

  // Header
  pushStr('GIF89a');
  push16(w);push16(h);
  push(0b11110111,0,0); // global color table, 256 colors
  bytes.push(...palette);

  // Netscape looping extension
  push(0x21,0xFF,11);pushStr('NETSCAPE2.0');push(3,1,0,0,0);

  for(const frame of frames){
    // Map pixels to palette indices
    const n=w*h;
    const indices=new Uint8Array(n);
    for(let i=0;i<n;i++){
      const o=i*4;
      indices[i]=nearestColor(frame.pixels[o],frame.pixels[o+1],frame.pixels[o+2],palette);
    }
    // Graphic control extension
    push(0x21,0xF9,4,0);push16(delay);push(0,0);
    // Image descriptor
    push(0x2C);push16(0);push16(0);push16(w);push16(h);push(0);
    // LZW
    const minCode=8;
    push(minCode);
    const lzw=lzwEncode(indices,minCode);
    bytes.push(...packSubBlocks(lzw));
  }
  push(0x3B);
  return new Uint8Array(bytes);
}
function exportCSV(){
  const rows=[['Rank','Name','Turfs','Percentage','Profile ID','Wallet','Inactive']];
  players.forEach((p,i)=>rows.push([i+1,p.name||'',p.tiles,totalTiles?(p.tiles/totalTiles*100).toFixed(4):'',p.pid,p.wallet||'',p.inactive?'yes':'no']));
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download='sui_players_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
}

// ── REFRESH MODAL ─────────────────────────────────────────────────────────────
function openRefreshModal(){document.getElementById('refresh-modal').classList.add('open');}
function closeRefreshModal(){document.getElementById('refresh-modal').classList.remove('open');document.getElementById('refresh-result').textContent='';}
async function triggerRefresh(){
  const token=document.getElementById('gh-token').value.trim();
  const repo=document.getElementById('gh-repo').value.trim();
  const el=document.getElementById('refresh-result');
  if(!token||!repo){el.style.color='#E24B4A';el.textContent='Please fill in both fields.';return;}
  el.style.color='#888';el.textContent='Triggering workflow...';
  try{
    const r=await fetch(`https://api.github.com/repos/${repo}/actions/workflows/update.yml/dispatches`,{
      method:'POST',headers:{'Authorization':'token '+token,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},
      body:JSON.stringify({ref:'main'})
    });
    if(r.status===204){el.style.color='#1D9E75';el.textContent='✓ Workflow started! Data will update in ~10 minutes.';}
    else{const d=await r.json();el.style.color='#E24B4A';el.textContent='Error '+r.status+': '+(d.message||'unknown');}
  }catch(e){el.style.color='#E24B4A';el.textContent='Error: '+e.message;}
}
document.getElementById('refresh-modal').addEventListener('click',e=>{if(e.target===document.getElementById('refresh-modal'))closeRefreshModal();});
document.addEventListener('click',e=>{
  const popup=document.getElementById('neighbor-popup');
  if(popup.style.display!=='none'&&!popup.contains(e.target))closeNeighborPopup();
  if(!e.target.closest('#intel-dropdown') && !e.target.closest('#intel-btn')) closeIntelMenu();
  if(!e.target.closest('#more-dropdown') && !e.target.closest('#more-btn')) closeMoreMenu();
});
