(function(){
'use strict';
var VERT='attribute vec2 position;varying vec2 vUv;void main(){vUv=position*0.5+0.5;gl_Position=vec4(position,0.0,1.0);}';
var FRAG=[
'precision highp float;',
'varying vec2 vUv;',
'uniform vec2 u_res;uniform vec2 u_mouse;',
'uniform float u_time;uniform float u_speed;',
'uniform float u_intensity;uniform float u_grain;',
'uniform float u_vignette;uniform float u_mouseInfluence;',
'uniform vec3 u_base;uniform vec3 u_mid;',
'uniform vec3 u_sheen;uniform vec3 u_accent;',
'',
'vec3 permute(vec3 x){return mod(((x*34.0)+1.0)*x,289.0);}',
'float snoise(vec2 v){',
'  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);',
'  vec2 i=floor(v+dot(v,C.yy));',
'  vec2 x0=v-i+dot(i,C.xx);',
'  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);',
'  vec4 x12=x0.xyxy+C.xxzz;',
'  x12.xy-=i1;',
'  i=mod(i,289.0);',
'  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));',
'  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);',
'  m=m*m;m=m*m;',
'  vec3 x=2.0*fract(p*C.www)-1.0;',
'  vec3 h=abs(x)-0.5;',
'  vec3 ox=floor(x+0.5);',
'  vec3 a0=x-ox;',
'  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);',
'  vec3 g;',
'  g.x=a0.x*x0.x+h.x*x0.y;',
'  g.yz=a0.yz*x12.xz+h.yz*x12.yw;',
'  return 130.0*dot(m,g);',
'}',
'',
'void main(){',
'  vec2 uv=vUv;',
'  float ratio=u_res.x/max(u_res.y,1.0);',
'  vec2 p=uv-0.5;',
'  p.x*=ratio;',
'  vec2 mouse=(u_mouse-0.5);',
'  mouse.x*=ratio;',
'  float t=u_time*0.1*u_speed;',
'',
'  float md=smoothstep(0.9,0.0,length(p-mouse));',
'  p+=(mouse-p)*md*0.03*u_mouseInfluence;',
'',
'  float n1=snoise(p*0.4+vec2(t*0.2,-t*0.3));',
'  float n2=snoise(p*0.55+vec2(-t*0.15,t*0.25)+n1*0.25);',
'  float n3=snoise(p*0.75+vec2(t*0.1,-t*0.2)+n2*0.2);',
'',
'  vec3 col=u_base;',
'  col=mix(col,u_sheen,smoothstep(-0.2,0.5,n1)*0.85*u_intensity);',
'  col=mix(col,u_accent,smoothstep(-0.1,0.6,n2)*0.7*u_intensity);',
'  col=mix(col,u_mid,smoothstep(-0.3,0.4,n3)*0.6*u_intensity);',
'  col=mix(col,u_sheen,smoothstep(0.0,0.7,n1*n2)*0.5*u_intensity);',
'',
'  float dist=length(p)*1.5;',
'  float vig=1.0-smoothstep(0.3,1.2,dist);',
'  float glow=smoothstep(0.8,0.0,dist)*0.3*u_intensity;',
'  col+=u_accent*glow;',
'  col=col*0.2+col*vig;',
'',
'  col*=mix(1.0-u_vignette*0.3,1.0,smoothstep(1.5,0.3,length(p)));',
'',
'  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);',
'}'
].join('\n');

function hexToRgb(hex){var h=hex.replace('#','');return[parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255];}

window.initSilkAurora=function(container,opts){
opts=opts||{};
var base=opts.baseColor||'#050507';
var mid=opts.midColor||'#14151d';
var sheen=opts.sheenColor||'#86efac';
var accent=opts.accentColor||'#059669';
var speed=opts.speed!=null?opts.speed:1.0;
var intensity=opts.intensity!=null?opts.intensity:1.0;
var grain=opts.grain!=null?opts.grain:0.0;
var vignette=opts.vignette!=null?opts.vignette:1.0;
var mouseInfluence=opts.mouseInfluence!=null?opts.mouseInfluence:1.0;
var canvas=document.createElement('canvas');
canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
canvas.setAttribute('aria-hidden','true');
container.style.position=container.style.position||'relative';
container.style.overflow='hidden';
container.insertBefore(canvas,container.firstChild);
var gl=canvas.getContext('webgl',{antialias:false,alpha:false});
if(!gl)return null;
function compile(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){gl.deleteShader(s);return null;}return s;}
var vs=compile(gl.VERTEX_SHADER,VERT);
var fs=compile(gl.FRAGMENT_SHADER,FRAG);
if(!vs||!fs)return null;
var pg=gl.createProgram();gl.attachShader(pg,vs);gl.attachShader(pg,fs);gl.linkProgram(pg);
if(!gl.getProgramParameter(pg,gl.LINK_STATUS)){gl.deleteProgram(pg);return null;}
gl.useProgram(pg);
var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
var pos=gl.getAttribLocation(pg,'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
var loc={};['u_res','u_mouse','u_time','u_speed','u_intensity','u_grain','u_vignette','u_mouseInfluence','u_base','u_mid','u_sheen','u_accent'].forEach(function(n){loc[n]=gl.getUniformLocation(pg,n);});
var bc=hexToRgb(base),mc=hexToRgb(mid),sc=hexToRgb(sheen),ac=hexToRgb(accent);
gl.uniform3f(loc.u_base,bc[0],bc[1],bc[2]);
gl.uniform3f(loc.u_mid,mc[0],mc[1],mc[2]);
gl.uniform3f(loc.u_sheen,sc[0],sc[1],sc[2]);
gl.uniform3f(loc.u_accent,ac[0],ac[1],ac[2]);
var mx={x:0.5,y:0.5},tmx={x:0.5,y:0.5};
function onMove(e){var r=container.getBoundingClientRect();tmx={x:(e.clientX-r.left)/r.width,y:1-(e.clientY-r.top)/r.height};}
function onLeave(){tmx={x:0.5,y:0.5};}
container.addEventListener('pointermove',onMove);
container.addEventListener('pointerleave',onLeave);
function resize(){var d=Math.min(window.devicePixelRatio||1,1.5);var w=container.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(w.width*d));canvas.height=Math.max(1,Math.floor(w.height*d));gl.viewport(0,0,canvas.width,canvas.height);gl.uniform2f(loc.u_res,canvas.width,canvas.height);}
resize();
var ro=new ResizeObserver(resize);ro.observe(container);
var start=performance.now();var raf=0;var paused=false;
var reduceMq=(window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):null);
function motionOK(){return !document.hidden&&!(reduceMq&&reduceMq.matches);}
function kick(){if(paused||raf||!motionOK())return;raf=requestAnimationFrame(render);}
function render(now){raf=0;if(paused)return;
mx.x+=(tmx.x-mx.x)*0.045;mx.y+=(tmx.y-mx.y)*0.045;
gl.uniform2f(loc.u_mouse,mx.x,mx.y);gl.uniform1f(loc.u_time,(now-start)/1000);
gl.uniform1f(loc.u_speed,speed);gl.uniform1f(loc.u_intensity,intensity);
gl.uniform1f(loc.u_grain,grain);gl.uniform1f(loc.u_vignette,vignette);
gl.uniform1f(loc.u_mouseInfluence,mouseInfluence);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
if(motionOK())raf=requestAnimationFrame(render);}
render(performance.now());kick();
function onVis(){if(document.hidden){if(raf){cancelAnimationFrame(raf);raf=0;}}else{kick();}}
document.addEventListener('visibilitychange',onVis);
if(reduceMq&&reduceMq.addEventListener){reduceMq.addEventListener('change',function(){if(motionOK())kick();});}
return{destroy:function(){cancelAnimationFrame(raf);raf=0;document.removeEventListener('visibilitychange',onVis);container.removeEventListener('pointermove',onMove);container.removeEventListener('pointerleave',onLeave);ro.disconnect();gl.deleteBuffer(buf);gl.deleteProgram(pg);gl.deleteShader(vs);gl.deleteShader(fs);},
set:function(o){if(!o)return;if(o.speed!=null)speed=o.speed;if(o.intensity!=null)intensity=o.intensity;if(o.grain!=null)grain=o.grain;if(o.vignette!=null)vignette=o.vignette;if(o.mouseInfluence!=null)mouseInfluence=o.mouseInfluence;},
pause:function(){paused=true;if(raf){cancelAnimationFrame(raf);raf=0;}},
resume:function(){if(!paused)return;paused=false;start=performance.now();kick();}};
};
})();