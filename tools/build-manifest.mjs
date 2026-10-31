// Parcourt Step1, Step2... : écrit manifest.json (textes, trajets, GPS, dates, vidéos, page de garde)
// et génère des miniatures dans thumbs/ (photos : "sharp" ; vidéos : "ffmpeg").
import crypto from 'crypto'; import fs from 'fs'; import path from 'path'; import exifr from 'exifr'; import { spawnSync } from 'child_process';
let sharp = null; try { sharp = (await import('sharp')).default; } catch { console.warn('sharp absent : pas de miniatures de photos'); }
const has = c => { try { return spawnSync(c, ['-version']).status === 0; } catch { return false; } };
const FF = has('ffmpeg') && has('ffprobe');
if (!FF) console.warn('ffmpeg absent : vidéos sans image d\'aperçu ni GPS/date automatiques');
const base0 = process.argv[2] || '.';
let root = base0, cachePath, cache, hashes;
const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const isImg = f => /\.(jpe?g|png|webp|heic)$/i.test(f);
const isVid = f => /\.(mp4|m4v|mov|webm|ogv)$/i.test(f);
const isMedia = f => isImg(f) || isVid(f);
const base = f => f.replace(/\.[^.]+$/, '').toLowerCase();
const num = s => +s.replace(',', '.');
// Extrait les lignes "trajet: droit|vol", "vol: oui|non", "gps: lat, lng" ; renvoie {mode, gps, text}
function parse(raw) {
  let mode = null, gps = null;
  const kept = raw.split(/\r?\n/).filter(l => {
    const g = l.match(/^\s*(?:gps|position)\s*:\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/i);
    if (g) { gps = [num(g[1]), num(g[2])]; return false; }
    const m = l.match(/^\s*(trajet|vol)\s*:\s*(\S+)/i);
    if (!m) return true;
    const v = m[2].toLowerCase();
    if (/^(droit|rectiligne|direct|route|non)/.test(v)) mode = 'straight';
    else if (/^(vol|avion|courbe|oui)/.test(v)) mode = 'flight';
    return false;
  });
  return { mode, gps, text: kept.join('\n').trim() };
}
const okFile = f => fs.existsSync(f) && fs.statSync(f).size > 0;
// Cache : empreinte (sha1) de chaque original, pour recréer une miniature quand la photo change
const hashOf = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const full = rel => (hashes[rel] ??= hashOf(path.join(root, rel)));
const vh = rel => full(rel).slice(0, 8);           // suffixe ?v=... : force le navigateur à recharger
const stale = (key, rel, dst) => !(okFile(dst) && cache[key] === full(rel));
// Miniature de photo : 480 px max, thumbs/<même chemin>.jpg (créée une seule fois)
async function mkThumb(rel) {
  if (!sharp) return null;
  const out = rel.replace(/\.[^.]+$/, '.jpg'), dst = path.join(root, 'thumbs', out);
  try {
    if (stale(rel, rel, dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await sharp(path.join(root, rel)).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72 }).toFile(dst);
      cache[rel] = full(rel);
    }
    return 'thumbs/' + out + '?v=' + vh(rel);
  } catch (e) { console.warn('  pas de miniature pour', rel, '-', e.message); return null; }
}
// Version allégée pour la visionneuse : 2000 px max, medium/<même chemin>.jpg (fluidité sur téléphone)
// Les petites photos (≤ 2000 px et < 700 Ko) sont utilisées telles quelles.
async function mkMedium(rel) {
  if (!sharp) return null;
  const out = rel.replace(/\.[^.]+$/, '.jpg'), src = path.join(root, rel), dst = path.join(root, 'medium', out);
  try {
    if (stale('m:' + rel, rel, dst)) {
      const meta = await sharp(src).metadata();
      if (Math.max(meta.width, meta.height) <= 2000 && fs.statSync(src).size < 700 * 1024) {
        fs.rmSync(dst, { force: true }); cache['m:' + rel] = full(rel); return null;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await sharp(src).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toFile(dst);
      cache['m:' + rel] = full(rel);
    }
    return okFile(dst) ? 'medium/' + out + '?v=' + vh(rel) : null;
  } catch (e) { console.warn('  pas de version allégée pour', rel, '-', e.message); return null; }
}
// Image d'aperçu d'une vidéo (1re image)
function mkPoster(rel) {
  if (!FF) return null;
  const out = rel.replace(/\.[^.]+$/, '.jpg'), dst = path.join(root, 'thumbs', out);
  if (stale(rel, rel, dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    for (const ss of ['0.5', '0']) {
      spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', ss, '-i', path.join(root, rel), '-frames:v', '1',
        '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', '-q:v', '4', dst]);
      if (okFile(dst)) break;
    }
    if (okFile(dst)) cache[rel] = full(rel);
  }
  if (okFile(dst)) return 'thumbs/' + out + '?v=' + vh(rel);
  try { fs.unlinkSync(dst); } catch {}
  console.warn('  pas d\'aperçu pour', rel); return null;
}
// GPS (ISO 6709) et date de prise de vue d'une vidéo
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return {};
  let j; try { j = JSON.parse(r.stdout); } catch { return {}; }
  const tags = Object.assign({}, ...(j.streams || []).map(s => s.tags || {}), j.format?.tags || {});
  const out = {};
  const loc = tags['com.apple.quicktime.location.ISO6709'] || tags.location || tags['location-eng'];
  const m = loc && String(loc).match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (m) { out.lat = +m[1]; out.lng = +m[2]; }
  for (const v of [tags['com.apple.quicktime.creationdate'], tags.creation_time]) {
    const dt = new Date(v);
    if (v && !isNaN(dt) && dt.getFullYear() > 1990) { out.date = dt.toISOString(); break; }
  }
  return out;
}
async function build(r) {
root = r; cachePath = path.join(root, 'thumbs', 'cache.json'); hashes = {};
cache = {}; try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
let album = {}; try { album = JSON.parse(fs.readFileSync(path.join(root, 'album.json'), 'utf8')); } catch {}
const cover = fs.readdirSync(root).find(f => /^(cover|couverture|garde)\.(jpe?g|png|webp)$/i.test(f));
if (cover) console.log('Page de garde :', cover);
const dirs = fs.readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^step\d+/i.test(d.name)).map(d => d.name).sort(nat);
const steps = [];
for (const d of dirs) {
  const files = fs.readdirSync(path.join(root, d)).sort(nat);
  const mediaBases = new Set(files.filter(isMedia).map(base));
  const txt = files.find(f => /\.txt$/i.test(f) && !mediaBases.has(base(f)));
  const sp = parse(txt ? fs.readFileSync(path.join(root, d, txt), 'utf8') : '');
  const lines = sp.text.split('\n');
  const first = lines.findIndex(l => l.trim());
  const name = first >= 0 ? lines[first].trim() : d;
  const desc = first >= 0 ? lines.slice(first + 1).join('\n').trim() : '';
  const photos = [];
  for (const f of files.filter(isMedia)) {
    const rel = `${d}/${f}`, p = path.join(root, rel), vid = isVid(f);
    const tf = files.find(t => /\.txt$/i.test(t) && base(t) === base(f));
    const pp = parse(tf ? fs.readFileSync(path.join(root, d, tf), 'utf8') : '');
    let g = null, date = null, thumb, med = null;
    if (vid) {
      const i = FF ? probe(p) : {};
      if (i.lat != null) g = { latitude: i.lat, longitude: i.lng };
      date = i.date || null; thumb = mkPoster(rel);
    } else {
      g = await exifr.gps(p).catch(() => null);
      const m = await exifr.parse(p, ['DateTimeOriginal']).catch(() => null);
      date = m?.DateTimeOriginal ? new Date(m.DateTimeOriginal).toISOString() : null;
      thumb = await mkThumb(rel); med = await mkMedium(rel);
    }
    if (pp.gps) g = { latitude: pp.gps[0], longitude: pp.gps[1] };
    photos.push({ src: rel + '?v=' + vh(rel), type: vid ? 'video' : 'image', thumb, med, text: pp.text, mode: pp.mode,
      lat: g?.latitude ?? null, lng: g?.longitude ?? null, date });
  }
  steps.push({ id: d, name, desc, mode: sp.mode, photos });
  const nv = photos.filter(p => p.type === 'video').length;
  console.log(d, '-', name, '-', photos.length - nv, 'photos,', nv, 'vidéos,', photos.filter(p => p.lat != null).length, 'géolocalisés');
}
// Nettoyage : miniatures / versions allégées dont la photo n'existe plus
if (sharp) {
  const used = new Set(steps.flatMap(st => st.photos.flatMap(p => [p.thumb, p.med])).filter(Boolean).map(x => x.split('?')[0]));
  const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  for (const f of [...walk(path.join(root, 'thumbs')), ...walk(path.join(root, 'medium'))]) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel !== 'thumbs/cache.json' && !used.has(rel)) fs.rmSync(f);
  }
}
for (const k of Object.keys(cache)) if (!fs.existsSync(path.join(root, k.replace(/^m:/, '')))) delete cache[k];
if (Object.keys(cache).length) { fs.mkdirSync(path.join(root, 'thumbs'), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1)); }
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  title: album.title, author: album.author, subtitle: album.subtitle, fade: album.fade,
  cover: cover ? { src: cover + '?v=' + vh(cover) } : null, steps }, null, 1));
return { title: album.title, author: album.author, subtitle: album.subtitle,
  cover: cover || steps.flatMap(st => st.photos).map(p => p.thumb || p.src).find(Boolean)?.split('?')[0] };
}
// Un carnet = un dossier contenant album.json (la racine elle-même peut en être un)
const isAlbum = d => fs.existsSync(path.join(d, 'album.json'));
const roots = isAlbum(base0) ? [base0] : [];
for (const e of fs.readdirSync(base0, { withFileTypes: true }))
  if (e.isDirectory() && !/^(\.|node_modules$|thumbs$|medium$|tools$)/.test(e.name) && !/^step\d+/i.test(e.name) && isAlbum(path.join(base0, e.name))) roots.push(path.join(base0, e.name));
if (!roots.length) roots.push(base0);
const list = [];
for (const r of roots) { console.log('=== Carnet :', r); const i = await build(r); if (r !== base0) list.push({ dir: path.basename(r), ...i }); }
if (list.length) fs.writeFileSync(path.join(base0, 'albums.json'), JSON.stringify(list, null, 1));
