import { useEffect, useRef, useState } from 'react';
import { api, uploadImage, prepareImage, initials } from '../../api.js';
import Logo, { photoStyle } from '../Logo.jsx';

const KEEP = { mode: 'keep' };

export default function Branding({ me, onSaved }) {
  const [server, setServer] = useState(null);
  const [logo, setLogo] = useState(KEEP); // keep | new (with prep) | remove
  const [photo, setPhoto] = useState(KEEP);
  const [focus, setFocus] = useState({ x: 50, y: 50 });
  const [dim, setDim] = useState(true);
  const [view, setView] = useState('login');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/admin/branding').then((b) => {
      setServer(b);
      setFocus(b.photoFocus);
      setDim(b.photoDim);
      setLogo(KEEP);
      setPhoto(KEEP);
    });
  useEffect(() => {
    load();
  }, []);

  if (!server) return <div className="card muted">Loading…</div>;

  const logoUrl = logo.mode === 'new' ? logo.prep.previewUrl : logo.mode === 'remove' ? null : server.logoUrl;
  const photoUrl = photo.mode === 'new' ? photo.prep.previewUrl : photo.mode === 'remove' ? null : server.photoUrl;
  const preview = { name: me.institution.name, code: me.institution.code, logoUrl, photoUrl, photoFocus: focus, photoDim: dim };
  const dirty =
    logo.mode !== 'keep' || photo.mode !== 'keep' || focus.x !== server.photoFocus.x || focus.y !== server.photoFocus.y || dim !== server.photoDim;

  async function choose(kind, file) {
    setMsg(null);
    if (!file) return;
    try {
      const prep = await prepareImage(file, kind);
      (kind === 'logo' ? setLogo : setPhoto)({ mode: 'new', prep });
      if (kind === 'photo') setFocus({ x: 50, y: 50 });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      if (logo.mode === 'new') await uploadImage('/admin/branding/logo', logo.prep.blob);
      if (logo.mode === 'remove') await api('/admin/branding/logo', { method: 'DELETE' });
      if (photo.mode === 'new') await uploadImage('/admin/branding/photo', photo.prep.blob);
      if (photo.mode === 'remove') await api('/admin/branding/photo', { method: 'DELETE' });
      await api('/admin/branding', { method: 'PATCH', body: { focusX: focus.x, focusY: focus.y, dim } });
      await load();
      await onSaved?.();
      setMsg({ type: 'success', text: 'Branding saved. Everyone sees it straight away.' });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="split">
      <div className="split-main stack">
        <section className="card stack-sm" aria-labelledby="logo-h">
          <div>
            <h2 id="logo-h" className="h3">
              Logo
            </h2>
            <p className="muted small no-margin">Shown on the login page, in search results, at the top of the app, in emails and on PDF and Excel reports.</p>
          </div>
          <div className="row align-start">
            <div className="logo-previews">
              <div className="logo-swatch light">{logoUrl ? <img src={logoUrl} alt="Logo on white" /> : <Logo inst={preview} size={56} />}</div>
              <div className="logo-swatch dark">{logoUrl ? <img src={logoUrl} alt="Logo on dark" /> : <Logo inst={preview} size={56} />}</div>
            </div>
            <div className="stack-sm grow">
              <div className="small">
                {logo.mode === 'new' ? (
                  <>
                    <strong>{logo.prep.name}</strong> <span className="muted">· {logo.prep.width} × {logo.prep.height} · not saved yet</span>
                  </>
                ) : logoUrl ? (
                  <span className="muted">Current logo</span>
                ) : (
                  <span className="muted">No logo: your initials ({initials(preview.name)}) are shown instead.</span>
                )}
              </div>
              <div className="row">
                <FilePick label={logoUrl ? 'Replace logo' : 'Upload logo'} accept="image/png,image/jpeg,image/webp" onFile={(f) => choose('logo', f)} />
                {logoUrl && (
                  <button type="button" className="danger" onClick={() => setLogo(server.logoUrl ? { mode: 'remove' } : KEEP)}>
                    Remove
                  </button>
                )}
                {logo.mode !== 'keep' && (
                  <button type="button" className="link" onClick={() => setLogo(KEEP)}>
                    Undo
                  </button>
                )}
              </div>
              <p className="muted small no-margin">Shown on white and dark so you can check it reads on both.</p>
            </div>
          </div>
          <div className="hint">PNG, JPG or WebP · square works best · at least 256 × 256 px · up to 1 MB · a transparent background looks best on photos.</div>
        </section>

        <section className="card stack-sm" aria-labelledby="photo-h">
          <div>
            <h2 id="photo-h" className="h3">
              Login photo
            </h2>
            <p className="muted small no-margin">A photo of your building or team, shown behind the login page and on each employee's "My day" screen.</p>
          </div>
          {photoUrl ? (
            <FocusPicker url={photoUrl} focus={focus} onChange={setFocus} />
          ) : (
            <div className="photo-empty muted small">No photo yet. Pages keep their plain look until you add one.</div>
          )}
          <div className="row">
            <FilePick label={photoUrl ? 'Replace photo' : 'Upload photo'} accept="image/png,image/jpeg,image/webp" onFile={(f) => choose('photo', f)} />
            {photoUrl && (
              <button type="button" className="danger" onClick={() => setPhoto(server.photoUrl ? { mode: 'remove' } : KEEP)}>
                Remove
              </button>
            )}
            {photo.mode !== 'keep' && (
              <button type="button" className="link" onClick={() => setPhoto(KEEP)}>
                Undo
              </button>
            )}
            {photo.mode === 'new' && (
              <span className="muted small">
                {photo.prep.name} · resized to {photo.prep.width} × {photo.prep.height} · not saved yet
              </span>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={dim} onChange={(e) => setDim(e.target.checked)} />
            <span>
              Darken the photo behind text
              <br />
              <span className="muted small">Keeps the login page easy to read on bright photos.</span>
            </span>
          </label>
          <div className="hint">JPG, PNG or WebP · at least 1600 px wide recommended · up to 5 MB. It's resized and compressed in your browser before upload, which also removes hidden location data.</div>
        </section>

        {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
        <div className="row">
          <button className="primary big" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save branding'}
          </button>
          <span className="muted small">{dirty ? 'You have unsaved changes.' : 'Everyone sees the change straight away.'}</span>
        </div>
      </div>

      <aside className="card split-side stack-sm" aria-labelledby="prev-h">
        <h2 id="prev-h" className="h3">
          Preview
        </h2>
        <div className="seg" role="group" aria-label="Preview">
          {[
            ['login', 'Login page'],
            ['search', 'Search'],
            ['email', 'Email'],
          ].map(([key, label]) => (
            <button key={key} type="button" className={view === key ? 'on' : ''} aria-pressed={view === key} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </div>
        {view === 'login' && <LoginPreview inst={preview} />}
        {view === 'search' && (
          <div className="pv pv-plain">
            <div className="strong">Find your institution</div>
            <div className="pv-input">{preview.code.slice(0, 3)}</div>
            <div className="inst-option static">
              <Logo inst={preview} size={36} />
              <span className="inst-text">
                <span className="strong">{preview.name}</span>
                <span className="muted small">
                  {window.location.host}/{preview.code}
                </span>
              </span>
            </div>
          </div>
        )}
        {view === 'email' && (
          <div className="pv pv-mail">
            <div className="mail">
              <div className="mail-head">
                {logoUrl && <img src={logoUrl} alt="" width="32" height="32" />}
                <div>
                  <div className="strong">{preview.name}</div>
                  <div className="muted small">Check-in</div>
                </div>
              </div>
              <div className="mail-body">
                <div>Eric Mugisha checked in late today.</div>
                <div className="muted">
                  Late by <strong className="amber-text">1 hr 25 min</strong>
                </div>
              </div>
            </div>
          </div>
        )}
        <p className="muted small no-margin">The preview updates as soon as you choose a file, before you save.</p>
      </aside>
    </div>
  );
}

function FilePick({ label, accept, onFile }) {
  const ref = useRef(null);
  return (
    <>
      <button type="button" onClick={() => ref.current?.click()}>
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Photo with a draggable dot that sets which part stays visible when the photo is cropped. */
function FocusPicker({ url, focus, onChange }) {
  const box = useRef(null);
  const dragging = useRef(false);

  const setFromPointer = (e) => {
    const r = box.current.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
    onChange({ x: Math.round(x), y: Math.round(y) });
  };

  const onKey = (e) => {
    const step = e.shiftKey ? 10 : 2;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    onChange({ x: Math.min(100, Math.max(0, focus.x + d[0])), y: Math.min(100, Math.max(0, focus.y + d[1])) });
  };

  return (
    <div
      ref={box}
      className="focus-box"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromPointer(e);
      }}
      onPointerMove={(e) => dragging.current && setFromPointer(e)}
      onPointerUp={() => (dragging.current = false)}
    >
      <img src={url} alt="Login photo" draggable="false" />
      <button
        type="button"
        className="focus-dot"
        style={{ left: `${focus.x}%`, top: `${focus.y}%` }}
        aria-label={`Focus point, ${focus.x}% across and ${focus.y}% down. Use the arrow keys to move it.`}
        onKeyDown={onKey}
      />
      <span className="focus-tip">Drag the dot to choose what stays in view on phones</span>
    </div>
  );
}

function LoginPreview({ inst }) {
  const style = photoStyle(inst);
  return (
    <div className={`pv pv-login ${style ? 'has-photo' : ''}`}>
      {style && <div className={`pv-photo ${inst.photoDim ? 'dim' : ''}`} style={style} />}
      <div className="pv-content">
        <Logo inst={inst} size={52} tile />
        <div className="pv-name">{inst.name}</div>
        <div className="pv-form">
          <div className="strong small">Log in to check in</div>
          <div className="pv-field" />
          <div className="pv-field" />
          <div className="pv-button" />
        </div>
      </div>
    </div>
  );
}
