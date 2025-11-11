"use client";

import { useState, useEffect } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot, doc, updateDoc } from "firebase/firestore";

// ---- Firebase init ----
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app;
if (!getApps().length) app = initializeApp(firebaseConfig);
else app = getApp();

// Forzar bucket correcto
const storage = getStorage(app, `gs://${process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET}`);
const db = getFirestore(app);

// ---- Types ----
type UploadedItem = {
  id: string;
  producto?: string;
  nombre?: string;
  tipo?: string; // compat histórica
  cantidad: number;
  archivos: { name: string; url: string; path: string; bytes: number }[];
  creadoEn?: { seconds: number; nanoseconds: number } | null;
  estado?: "pendiente" | "impreso" | "enviado" | "despachado";
  impresoEn?: { seconds: number; nanoseconds: number } | null;
  enviadoEn?: { seconds: number; nanoseconds: number } | null;
  despachadoEn?: { seconds: number; nanoseconds: number } | null;
};

// ---- Helpers UI ----
const formatDate = (ts?: { seconds: number }) =>
  ts ? new Date(ts.seconds * 1000).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";

const chipClass = (estado: string) => {
  const base = "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium";
  if (estado === "enviado" || estado === "despachado") return base + " bg-green-100 text-green-800";
  if (estado === "impreso") return base + " bg-blue-100 text-blue-800";
  return base + " bg-zinc-200 text-zinc-800";
};

const bytesToKB = (b?: number) => (typeof b === "number" ? `${(b / 1024).toFixed(1)} KB` : "");

// New small React components for consistent buttons and icons
const Icon = ({ name, size = 14 }: { name: "open" | "download" | "link" | "print" | "send" | "paperclip"; size?: number }) => {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as any;
  switch (name) {
    case "open":
      return (<svg {...common}><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M5 21h14a2 2 0 0 0 2-2V9"/></svg>);
    case "download":
      return (<svg {...common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>);
    case "link":
      return (<svg {...common}><path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5"/><path d="M14 11a5 5 0 0 0-7.07 0L5.5 12.43a5 5 0 0 0 7.07 7.07L14 19"/></svg>);
    case "print":
      return (<svg {...common}><path d="M6 9V2h12v7"/><path d="M6 18h12v4H6z"/><path d="M6 14H4a2 2 0 0 1-2-2v-1a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v1a2 2 0 0 1-2 2h-2"/></svg>);
    case "send":
      return (<svg {...common}><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>);
    case "paperclip":
      return (<svg {...common}><path d="M21.44 11.05l-9.19 9.19a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66L9.17 18.26a2 2 0 1 1-2.83-2.83l8.49-8.49"/></svg>);
  }
  return null;
};

const GhostBtn = ({ children, onClick, href, download }: { children: React.ReactNode; onClick?: () => void; href?: string; download?: boolean }) => (
  href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      download={download}
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-xs text-zinc-800 hover:bg-zinc-50 whitespace-nowrap w-full md:w-auto"
    >
      {children}
    </a>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-xs text-zinc-800 hover:bg-zinc-50 whitespace-nowrap w-full md:w-auto"
    >
      {children}
    </button>
  )
);

const PrimaryMini = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex h-8 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:opacity-90 whitespace-nowrap w-full md:w-auto"
  >
    {children}
  </button>
);

export default function Page() {
  // Form state
  const [producto, setProducto] = useState("");
  const [nombre, setNombre] = useState("");
  const [cantidad, setCantidad] = useState<number>(1);
  const [files, setFiles] = useState<FileList | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState<string>("");

  // Data state
  const [recent, setRecent] = useState<UploadedItem[]>([]);
  const [filtroEstado, setFiltroEstado] = useState<string>("todos");

  // Realtime list
  useEffect(() => {
    const q = query(collection(db, "subidas"), orderBy("creadoEn", "desc"), limit(50));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: UploadedItem[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setRecent(rows);
      },
      (err) => {
        console.error("Firestore listener error:", err);
        setMsg("Sin permisos para leer 'subidas'. Ajusta las reglas de Firestore.");
      }
    );
    return () => unsub();
  }, []);

  // Actions
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files || !producto) {
      setMsg("Completa producto y adjunta al menos un PDF.");
      return;
    }
    setUploading(true);
    setProgress(0);
    setMsg("");

    try {
      const uploaded: { name: string; url: string; path: string; bytes: number }[] = [];
      for (const file of Array.from(files)) {
        if (file.type !== "application/pdf") {
          setMsg("Solo se aceptan PDF.");
          setUploading(false);
          return;
        }
        const path = `etiquetas/${Date.now()}_${file.name}`;
        const storageRef = ref(storage, path);
        const task = uploadBytesResumable(storageRef, file);

        await new Promise<void>((resolve, reject) => {
          task.on(
            "state_changed",
            (snap) => {
              const p = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
              setProgress(p);
            },
            reject,
            async () => {
              const url = await getDownloadURL(task.snapshot.ref);
              uploaded.push({ name: file.name, url, path, bytes: file.size });
              resolve();
            }
          );
        });
      }

      await addDoc(collection(db, "subidas"), {
        producto,
        nombre,
        tipo: producto,
        cantidad: Number(cantidad),
        archivos: uploaded,
        creadoEn: serverTimestamp(),
        estado: "pendiente",
        impresoEn: null,
        enviadoEn: null,
        despachadoEn: null,
      });

      setMsg("Subida completada.");
      setProducto("");
      setNombre("");
      setCantidad(1);
      setFiles(null);
      setProgress(0);
    } catch (err) {
      console.error("Upload failed:", err);
      setMsg("Error al subir. Revisa consola.");
    } finally {
      setUploading(false);
    }
  };

  const marcarImpreso = async (id: string) => {
    await updateDoc(doc(db, "subidas", id), {
      estado: "impreso",
      impresoEn: serverTimestamp(),
    });
  };

  const marcarEnviado = async (id: string) => {
    await updateDoc(doc(db, "subidas", id), {
      estado: "enviado",
      enviadoEn: serverTimestamp(),
    });
  };

  // Derived
  const counts = {
    total: recent.length,
    pendiente: recent.filter((r) => (r.estado || "pendiente") === "pendiente").length,
    impreso: recent.filter((r) => r.estado === "impreso").length,
    enviado: recent.filter((r) => (r.estado === "enviado" || r.estado === "despachado")).length,
  };

  const filtered = recent.filter((r) =>
    filtroEstado === "todos"
      ? true
      : (r.estado === "despachado" ? "enviado" : (r.estado || "pendiente")) === filtroEstado
  );

  return (
    <div className="min-h-screen bg-zinc-50 py-10">
      <main className="mx-auto w-full max-w-4xl px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Subir etiquetas eBay</h1>

        {/* Card form */}
        <form onSubmit={handleSubmit} className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-4">
            <label className="block">
              <div className="text-sm font-medium text-zinc-800">Producto</div>
              <input
                value={producto}
                onChange={(e) => setProducto(e.target.value)}
                placeholder="Ej: Fuxion - Thermo T3"
                className="mt-1 w-full rounded-xl border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-800"
                required
              />
              <p className="mt-1 text-xs text-zinc-500">Nombre del artículo vendido.</p>
            </label>

            <label className="block">
              <div className="text-sm font-medium text-zinc-800">Nombre</div>
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Cliente o referencia interna"
                className="mt-1 w-full rounded-xl border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-800"
              />
            </label>

            <div className="flex items-end gap-4">
              <label className="flex-1 block">
                <div className="text-sm font-medium text-zinc-800">Cantidad</div>
                <input
                  type="number"
                  min={1}
                  value={cantidad}
                  onChange={(e) => setCantidad(Number(e.target.value))}
                  className="mt-1 w-32 rounded-xl border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-800"
                  required
                />
              </label>

              <div className="flex-1">
                <div className="text-sm font-medium text-zinc-800">Adjuntar PDF(s)</div>
                <div className="mt-1 inline-flex">
                  <input
                    id="file-input"
                    ref={undefined}
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={(e) => setFiles(e.target.files)}
                    className="sr-only peer"
                    required
                  />
                  <label
                    htmlFor="file-input"
                    className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-2xl border border-zinc-200 bg-gradient-to-b from-white to-zinc-50/90 px-4 text-sm font-medium text-zinc-900 shadow-sm backdrop-blur-sm transition-all hover:border-zinc-800 hover:shadow-md active:scale-[0.99] peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-900"
                  >
                    <Icon name="paperclip" size={16} /> Elegir archivos
                  </label>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {files && files.length > 0
                    ? `${files.length} archivo${files.length > 1 ? 's' : ''} seleccionado${files.length > 1 ? 's' : ''}`
                    : "Podés seleccionar uno o varios PDF"}
                </div>
              </div>

              <div className="pt-6">
                <button
                  disabled={uploading}
                  className="inline-flex h-11 items-center justify-center rounded-full bg-zinc-900 px-6 text-sm font-medium text-white shadow-sm transition-all hover:opacity-95 active:scale-[0.99] disabled:opacity-50"
                >
                  {uploading ? "Subiendo…" : "Subir PDF(s)"}
                </button>
              </div>
            </div>

            {uploading && (
              <div className="mt-2">
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                  <div className="h-full rounded-full bg-zinc-900" style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-1 text-right text-xs text-zinc-600">{progress}%</div>
              </div>
            )}

            {msg && (
              <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-800" role="status" aria-live="polite">
                {msg}
              </div>
            )}
          </div>
        </form>

        {/* List header with tabs */}
        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-semibold text-zinc-900">Subidas recientes</h2>
          </div>

          <div className="mb-4 flex gap-2">
            {([
              { key: "todos", label: `Todos (${counts.total})` },
              { key: "pendiente", label: `Pendientes (${counts.pendiente})` },
              { key: "impreso", label: `Impresos (${counts.impreso})` },
              { key: "enviado", label: `Enviados (${counts.enviado})` },
            ] as { key: string; label: string }[]).map((t) => (
              <button
                key={t.key}
                onClick={() => setFiltroEstado(t.key)}
                className={
                  "inline-flex items-center rounded-full border px-3 py-1 text-sm " +
                  (filtroEstado === t.key
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 bg-white text-zinc-800 hover:border-zinc-900")
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-zinc-50 text-zinc-700">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Fecha</th>
                  <th className="px-4 py-3 text-left font-medium">Producto</th>
                  <th className="px-4 py-3 text-left font-medium">Nombre</th>
                  <th className="px-2 py-3 text-left font-medium">Cant.</th>
                  <th className="px-4 py-3 text-left font-medium">Estado</th>
                  <th className="px-4 py-3 text-left font-medium">Archivo</th>
                  <td className="px-4 py-3 align-top w-[520px] md:w-[420px] overflow-visible"></td>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-zinc-500">
                      No hay subidas para este filtro.
                    </td>
                  </tr>
                )}
                {filtered.map((r) =>
                  r.archivos?.map((f, idx) => (
                    <tr key={`${r.id}-${idx}`} className="border-t border-zinc-200 hover:bg-zinc-50">
                      <td className="px-4 py-3 whitespace-nowrap">{formatDate(r.creadoEn as any)}</td>
                      <td className="px-4 py-3">{r.producto || r.tipo || "-"}</td>
                      <td className="px-4 py-3">{r.nombre || "-"}</td>
                      <td className="px-2 py-3">{r.cantidad}</td>
                      <td className="px-4 py-3"><span className={chipClass(r.estado === "despachado" ? "enviado" : (r.estado || "pendiente"))}>{r.estado === "despachado" ? "enviado" : (r.estado || "pendiente")}</span></td>
                      <td className="px-4 py-3 max-w-[100px]">
                        <div className="truncate" title={f.name}>{f.name}</div>
                        <div className="text-xs text-zinc-500">{bytesToKB(f.bytes)}</div>
                      </td>
                      <td className="px-4 py-3 align-top w-[420px] md:w-[360px] overflow-visible">
                        <div className="flex flex-col md:flex-row md:flex-wrap items-stretch md:items-center gap-2">
                          <GhostBtn href={f.url}><Icon name="open" /> Abrir</GhostBtn>
                          <GhostBtn href={f.url} download><Icon name="download" /> Descargar</GhostBtn>
                          <GhostBtn onClick={() => { navigator.clipboard.writeText(f.url); setMsg("Link copiado al portapapeles"); }}><Icon name="link" /> Copiar link</GhostBtn>
                          {(r.estado || "pendiente") === "pendiente" && (
                            <PrimaryMini onClick={() => marcarImpreso(r.id)}><Icon name="print" /> Marcar impreso</PrimaryMini>
                          )}
                          {(r.estado || "pendiente") === "impreso" && (
                            <PrimaryMini onClick={() => marcarEnviado(r.id)}><Icon name="send" /> Marcar enviado</PrimaryMini>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
