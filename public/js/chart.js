/* Rating over time as a small inline SVG line, with the 1500 starting rating dashed. */
export function sparkline(values,{base=1500}={}){
  if(values.length<2) return '';
  const W=300,H=90,pad=4, lo=Math.min(base,...values), hi=Math.max(base,...values), span=hi-lo||1;
  const x=i=>(pad+i*(W-2*pad)/(values.length-1)).toFixed(1);
  const y=v=>(pad+(hi-v)*(H-2*pad)/span).toFixed(1);
  const pts=values.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="Rating over ${values.length-1} games, from ${Math.round(values[0])} to ${Math.round(values.at(-1))}">
    <line class="base" x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}"/>
    <polygon class="area" points="${x(0)},${H} ${pts} ${x(values.length-1)},${H}"/>
    <polyline class="ln" points="${pts}"/></svg>`;
}
