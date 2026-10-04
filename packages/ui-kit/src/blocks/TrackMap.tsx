import { color, font } from "../tokens.js";
import { MapView, type MapLand, type MapPath, type MapPin } from "./MapView.js";

export interface TrackMapProps {
  title: string;
  format: string;
  originalPath: string;
  originalName: string;
  originalHref?: string;
  /** One path per usable section; original and recovered gaps stay separate. */
  paths: MapPath[];
  fitPoints: { lat: number; lon: number }[];
  endpoints: MapPin[];
  /** A projection refusal keeps the entire textual record and original. */
  projectionReason?: string;
  background?: { paths: MapPath[]; land?: MapLand; attribution?: string };
  metrics: { label: string; value: string; reason?: string }[];
  evidence: string[];
  waypoints: { name: string; coordinate: string; elevation?: string; time?: string }[];
}

/** File evidence on a static, conformal drawing. The kit performs no I/O or measurement. */
export function TrackMap(p: TrackMapProps) {
  const plain = !p.background?.paths.length && !p.background?.land?.rings.length;
  return <section data-track-map="" style={{ maxWidth: 420, width: "100%", boxSizing: "border-box", border: `1px solid ${color.edge}`, borderRadius: 12, overflow: "hidden", background: color.surface, color: color.ink, fontFamily: font.body }}>
    <div style={{ padding: "14px 16px 10px" }}>
      <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>{p.title}</div>
      <div style={{ marginTop: 4, fontSize: 11, color: color.inkDim, lineHeight: 1.5 }}>{p.format} · file-provided coordinates · timestamps do not prove travel</div>
    </div>
    {p.projectionReason ? <p style={{ padding: "0 16px", fontSize: 12, lineHeight: 1.5 }}>{p.projectionReason}</p>
      : <><MapView pins={p.endpoints} fitPoints={p.fitPoints} paths={[...(p.background?.paths ?? []), ...p.paths]} land={p.background?.land} width={420} height={220} spanKm={0.1} clusterPx={18} coordChip={false} framed={false} title="" subtitle="" meta="" note="" attribution={p.background?.attribution} describe={{ label: "File-provided track with start and end markers; separate lines preserve gaps" }} />
      <div style={{ padding: "8px 16px", font: `11px/1.5 ${font.mono}`, color: color.inkDim }}>{plain ? "Track only · no background geography" : "Track over background geography"} · S triangle: start · E square: end · S/E: endpoints together</div></>}
    <dl style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)", gap: "8px 12px", margin: 0, padding: "12px 16px", borderTop: `1px solid ${color.edge}`, fontSize: 12, lineHeight: 1.5 }}>
      {p.metrics.map(row => <div key={row.label} style={{ display: "contents" }}><dt style={{ color: color.inkDim }}>{row.label}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{row.value}{row.reason && <div style={{ fontSize: 11, color: color.inkDim }}>{row.reason}</div>}</dd></div>)}
    </dl>
    <div style={{ padding: "0 16px 12px", fontSize: 11, lineHeight: 1.6, color: color.inkDim, overflowWrap: "anywhere" }}>
      {p.evidence.map((text, index) => <div key={index}>{text}</div>)}
      <div style={{ marginTop: 6, overflowWrap: "anywhere" }}>Original: {p.originalHref ? <a href={p.originalHref} download={p.originalName} style={{ color: color.ink, textDecoration: "underline" }}>{p.originalName}</a> : p.originalName}<br /><span style={{ fontFamily: font.mono }}>{p.originalPath}</span></div>
    </div>
    <div style={{ borderTop: `1px solid ${color.edge}`, padding: "12px 16px", fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600 }}>Waypoints · {p.waypoints.length}</div>
      {!p.waypoints.length && <div style={{ color: color.inkDim, marginTop: 4 }}>No usable waypoints in file.</div>}
      <ol style={{ paddingLeft: 20, margin: "8px 0 0" }}>{p.waypoints.map((point, index) => <li key={index} style={{ marginBottom: 8, overflowWrap: "anywhere" }}>{point.name || `Waypoint ${index + 1}`}<div style={{ font: `11px/1.5 ${font.mono}`, color: color.inkDim }}>{point.coordinate}{point.elevation && ` · ${point.elevation}`}{point.time && <div>{point.time}</div>}</div></li>)}</ol>
    </div>
  </section>;
}
