import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { getStroke } from 'perfect-freehand'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
if (typeof Worker !== 'undefined') {
  try {
    // @ts-ignore
    pdfjs.GlobalWorkerOptions.workerPort = new (PdfWorker as any)()
  } catch {
    // @ts-ignore
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  }
} else {
  // @ts-ignore
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
}

type Point = { x: number; y: number; pressure?: number }

type ShapeType = 'rectangle' | 'ellipse' | 'triangle' | 'arrow'
type LineStyle = 'solid' | 'dashed'

type Stroke = {
  id: string
  points: Point[] // normalized 0-1
  color: string
  width: number
  straight?: boolean
  dashed?: boolean // kesikli kalemden geldiyse true — render ve PDF export'ta dash uygulanır
}

type Shape = {
  id: string
  type: ShapeType
  start: Point
  end: Point
  color: string
  width: number
  fill: boolean
  lineStyle: LineStyle
  page: number
}

const COLORS = ['#000000', '#ef4444', '#2563eb', '#16a34a', '#eab308', '#9333ea', '#ff6900', '#14b8a6', '#f97316', '#a855f7']
// kalınlık artık slider 0.5-10, sabit WIDTHS kaldırıldı

// --- kalıcı tercihler (localStorage) ---
const PREFS_KEY = 'annotate-pdf:prefs'
const UNDO_LIMIT = 40 // bellek üst sınırı: sayfa başına maks. geri alma adımı

type Prefs = { tool?: string; color?: string; width?: number; shapeFill?: boolean; lineStyle?: string; theme?: string; scale?: number }

function loadPrefs(): Prefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Prefs } catch { return {} }
}
function savePrefs(p: Prefs) {
  try {
    const prev = loadPrefs()
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prev, ...p }))
  } catch { /* kota dolu vb. — sessizce yut */ }
}

function hexToRgbVals(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}
function getSvgPath(stroke: number[][]) {
  if (!stroke.length) return ''
  let d = `M ${stroke[0][0]} ${stroke[0][1]}`
  for (let i = 1; i < stroke.length; i++) d += ` L ${stroke[i][0]} ${stroke[i][1]}`
  d += ' Z'
  return d
}

import { FolderOpen, Pencil, Eraser, Palette, SlidersHorizontal, Undo2, Redo2, Trash2, PanelLeft, ZoomIn, ZoomOut, Download, Sun, Moon, ChevronLeft, ChevronRight, Square, Circle, Triangle, ArrowRight, Minus, SquareDashed, MousePointer2 } from 'lucide-react'

/* ---------- thumbnail item (low quality, cached) ---------- */
function ThumbItem({ pageNum, pdfDoc, isActive, onClick }: { pageNum: number; pdfDoc: pdfjs.PDFDocumentProxy; isActive: boolean; onClick: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    let task: any = null
    const t = setTimeout(async () => {
      try {
        const page = await pdfDoc.getPage(pageNum)
        if (cancelled) return
        const viewport = page.getViewport({ scale: 0.22 })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        // @ts-ignore
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        task = page.render({ canvasContext: ctx as any, viewport })
        await task.promise
        if (!cancelled) setReady(true)
      } catch (e: any) {
        if (!String(e?.message || '').includes('cancel')) console.error(e)
      }
    }, (pageNum % 7) * 30) // stagger to avoid burst
    return () => { cancelled = true; clearTimeout(t); try { task?.cancel() } catch {} }
  }, [pdfDoc, pageNum])

  return (
    <button onClick={onClick}
      className="w-full text-left rounded-[10px] p-2 transition border"
      style={{
        background: isActive ? 'color-mix(in srgb, var(--toolbar-accent) 12%, var(--bg-card))' : 'var(--bg-card)',
        borderColor: isActive ? 'var(--toolbar-accent)' : 'var(--border)',
        boxShadow: isActive ? '0 0 0 1px var(--toolbar-accent)' : 'none'
      }}>
      <div className="bg-white rounded-[6px] overflow-hidden border flex items-center justify-center" style={{ borderColor: '#e5e7eb', minHeight: 92 }}>
        <canvas ref={canvasRef} className="block max-w-full" style={{ opacity: ready ? 1 : 0, transition: 'opacity 200ms' }} />
        {!ready && <span className="text-[10px] py-6" style={{ color:'#9ca3af' }}>Yükleniyor…</span>}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium" style={{ color: isActive ? 'var(--toolbar-accent)' : 'var(--text-muted)' }}>{pageNum}</span>
        {isActive && <span className="w-1.5 h-1.5 rounded-full" style={{ background:'var(--toolbar-accent)' }} />}
      </div>
    </button>
  )
}

export default function App() {
  // kalıcı tercihler (bir kez okunur)
  const prefsRef = useRef<Prefs>(loadPrefs())
  const P = prefsRef.current

  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null)
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [fileName, setFileName] = useState('document.pdf')
  const [loading, setLoading] = useState(false)
  const [scale, setScale] = useState<number>(() => (typeof P.scale === 'number' && P.scale >= 0.6 && P.scale <= 4 ? P.scale : 1.35))
  const viewportW = useRef(0)
  const viewportH = useRef(0)

  const VALID_TOOLS = ['pen','eraser','dashed-pen','select','rectangle','ellipse','triangle','arrow'] as const
  const [tool, setTool] = useState<(typeof VALID_TOOLS)[number]>(() => (VALID_TOOLS as readonly string[]).includes(P.tool || '') ? P.tool as (typeof VALID_TOOLS)[number] : 'pen')
  const [color, setColor] = useState(() => /^#[0-9a-fA-F]{6}$/.test(P.color || '') ? P.color! : '#000000')
  const [width, setWidth] = useState<number>(() => (typeof P.width === 'number' && P.width >= 0.5 && P.width <= 10 ? P.width : 4))
  const [strokesByPage, setStrokesByPage] = useState<Record<number, Stroke[]>>({})
  const [shapesByPage, setShapesByPage] = useState<Record<number, Shape[]>>({})
  const [undoStacks, setUndoStacks] = useState<Record<number, { strokes: Stroke[]; shapes: Shape[] }[]>>({})
  const [redoStacks, setRedoStacks] = useState<Record<number, { strokes: Stroke[]; shapes: Shape[] }[]>>({})
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const [showThumbs, setShowThumbs] = useState(false)
  const [showColor, setShowColor] = useState(false)
  const [showWidth, setShowWidth] = useState(false)
  const [showFill, setShowFill] = useState(false)
  const [showLineStyle, setShowLineStyle] = useState(false)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)

  const [shapeFill, setShapeFill] = useState<boolean>(() => typeof P.shapeFill === 'boolean' ? P.shapeFill : true)
  const [lineStyle, setLineStyle] = useState<LineStyle>(() => P.lineStyle === 'dashed' ? 'dashed' : 'solid')

  // şekil seçim / taşıma
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const dragShapeRef = useRef<{ id: string; start: Point; end: Point } | null>(null)
  const dragGrabRef = useRef<{ px: number; py: number; s0: Point; e0: Point } | null>(null)

  const [pageEditing, setPageEditing] = useState(false)
  const [pageInput, setPageInput] = useState('')
  const pageInputRef = useRef<HTMLInputElement>(null)
  const [zoomEditing, setZoomEditing] = useState(false)
  const [zoomInput, setZoomInput] = useState('')
  const zoomInputRef = useRef<HTMLInputElement>(null)

  const currentPointsRef = useRef<Point[]>([])
  const isDrawingRef = useRef(false)
  const ctrlRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null)
  const drawCanvasRef = useRef<HTMLCanvasElement>(null)
  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)

  // shape drawing refs
  const shapeStartRef = useRef<Point | null>(null)
  const shapePreviewRef = useRef<Shape | null>(null)

  // thumb virtualization
  const thumbScrollRef = useRef<HTMLDivElement>(null)
  const [thumbScrollTop, setThumbScrollTop] = useState(0)
  const [thumbViewportH, setThumbViewportH] = useState(600)
  const ITEM_H = 132

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (P.theme === 'dark') return 'dark'
    if (P.theme === 'light') return 'light'
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
    return 'light'
  })
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])

  // tercihleri kalıcılaştır (değişen alanları birleştirerek yaz)
  useEffect(() => {
    savePrefs({ tool, color, width, shapeFill, lineStyle, theme, scale })
  }, [tool, color, width, shapeFill, lineStyle, theme, scale])

  const canUndo = (undoStacks[pageNum]?.length ?? 0) > 0
  const canRedo = (redoStacks[pageNum]?.length ?? 0) > 0

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Control') ctrlRef.current = true }
    const up = (e: KeyboardEvent) => { if (e.key === 'Control') ctrlRef.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  // thumb scroll tracking
  useEffect(() => {
    const el = thumbScrollRef.current
    if (!el) return
    const onScroll = () => setThumbScrollTop(el.scrollTop)
    const ro = new ResizeObserver(() => setThumbViewportH(el.clientHeight))
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(el)
    setThumbViewportH(el.clientHeight)
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect() }
  }, [showThumbs, totalPages])

  const loadPdf = useCallback(async (bytes: ArrayBuffer, name: string) => {
    setLoading(true)
    try {
      if (pdfDocRef.current) { try { await pdfDocRef.current.destroy() } catch {} }
      const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise
      pdfDocRef.current = doc
      setPdfDoc(doc)
      setTotalPages(doc.numPages)
      setPageNum(1)
      setStrokesByPage({})
      setUndoStacks({})
      setRedoStacks({})
      setPdfBytes(bytes.slice(0))
      setFileName(name.replace(/\.pdf$/i, '') + '.pdf')
      setThumbScrollTop(0)
      thumbScrollRef.current && (thumbScrollRef.current.scrollTop = 0)
    } catch (e) { console.error(e); alert('PDF yüklenemedi') } finally { setLoading(false) }
  }, [])

  const onFile = useCallback(async (f: File) => {
    const buf = await f.arrayBuffer()
    await loadPdf(buf, f.name)
  }, [loadPdf])

  const renderPageDPR = useCallback(async () => {
    if (!pdfDoc || !pdfCanvasRef.current || !drawCanvasRef.current) return
    const pdfCanvas = pdfCanvasRef.current
    const drawCanvas = drawCanvasRef.current
    const ctx = pdfCanvas.getContext('2d')
    if (!ctx) return
    if (renderTaskRef.current) { try { renderTaskRef.current.cancel() } catch {} }
    const page = await pdfDoc.getPage(pageNum)
    const dpr = window.devicePixelRatio || 1
    const viewport = page.getViewport({ scale })
    const w = viewport.width, h = viewport.height
    viewportW.current = w; viewportH.current = h
    pdfCanvas.width = Math.round(w * dpr); pdfCanvas.height = Math.round(h * dpr)
    pdfCanvas.style.width = `${w}px`; pdfCanvas.style.height = `${h}px`
    drawCanvas.width = Math.round(w * dpr); drawCanvas.height = Math.round(h * dpr)
    drawCanvas.style.width = `${w}px`; drawCanvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const task = page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport } as never)
    renderTaskRef.current = task as unknown as pdfjs.RenderTask
    try { await task.promise } catch (e) { if ((e as Error)?.message?.includes('cancel')) return; throw e }
    drawOverlay()
  }, [pdfDoc, pageNum, scale])

  useEffect(() => { renderPageDPR() }, [renderPageDPR])

  function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, w: number, h: number, isPreview: boolean) {
    const { start, end, color, width, fill, lineStyle, type } = shape
    const x1 = start.x * w, y1 = start.y * h
    const x2 = end.x * w, y2 = end.y * h
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2

    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (!fill) ctx.globalAlpha = isPreview ? 0.8 : 1
    else if (isPreview) ctx.globalAlpha = 0.9
    if (lineStyle === 'dashed') ctx.setLineDash([8, 4])
    else ctx.setLineDash([])

    if (type === 'rectangle') {
      const x = Math.min(x1, x2), y = Math.min(y1, y2)
      const wRect = Math.abs(x2 - x1), hRect = Math.abs(y2 - y1)
      if (fill) ctx.fillRect(x, y, wRect, hRect)
      ctx.strokeRect(x, y, wRect, hRect)
    } else if (type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      if (fill) ctx.fill()
      ctx.stroke()
    } else if (type === 'triangle') {
      const left = Math.min(x1, x2), right = Math.max(x1, x2)
      const top = Math.min(y1, y2), bottom = Math.max(y1, y2)
      ctx.beginPath()
      ctx.moveTo((left + right) / 2, top)
      ctx.lineTo(right, bottom)
      ctx.lineTo(left, bottom)
      ctx.closePath()
      if (fill) ctx.fill()
      ctx.stroke()
    } else if (type === 'arrow') {
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const headLen = Math.max(width * 3, 15)
      ctx.translate(x1, y1)
      ctx.rotate(angle)
      const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(len, 0)
      ctx.lineTo(len - headLen, -headLen / 2)
      ctx.moveTo(len, 0)
      ctx.lineTo(len - headLen, headLen / 2)
      ctx.stroke()
      // draw arrow body as line if not filled
      if (!fill) {
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.lineTo(len, 0)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  const pushUndo = useCallback((page: number, prevStrokes: Stroke[], prevShapes: Shape[] = []) => {
    setUndoStacks(s => {
      const stack = [...(s[page] ?? []), { strokes: prevStrokes, shapes: prevShapes }]
      // bellek üst sınırı: en eski snapshot'ları at
      return { ...s, [page]: stack.length > UNDO_LIMIT ? stack.slice(stack.length - UNDO_LIMIT) : stack }
    })
    setRedoStacks(s => ({ ...s, [page]: [] }))
  }, [])

  const drawOverlay = useCallback(() => {
    const canvas = drawCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = viewportW.current, h = viewportH.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // draw strokes
    const strokes = strokesByPage[pageNum] ?? []
    for (const s of strokes) {
      if (s.points.length < 1) continue
      if ((s.straight || s.dashed) && s.points.length >= 2) {
        // düz veya kesikli: noktalar üzerinden stroke (dolgu değil)
        ctx.beginPath()
        ctx.strokeStyle = s.color
        ctx.lineWidth = s.width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.setLineDash(s.dashed ? [8, 4] : [])
        ctx.moveTo(s.points[0].x * w, s.points[0].y * h)
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * w, s.points[i].y * h)
        if (s.straight && !s.dashed && s.points.length === 2) { /* uçtan uca */ }
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        const pts = s.points.map(p => [p.x * w, p.y * h] as [number, number])
        const input = s.points.map(p => ({ x: p.x * w, y: p.y * h, pressure: p.pressure ?? 0.5 }))
        const outline = getStroke(input as never, { size: s.width * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5 }) as unknown as number[][]
        if (outline.length < 3) { ctx.beginPath(); ctx.fillStyle = s.color; ctx.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2); ctx.fill(); continue }
        ctx.beginPath(); ctx.fillStyle = s.color; ctx.moveTo(outline[0][0], outline[0][1]); for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]); ctx.closePath(); ctx.fill()
      }
    }

    // draw shapes
    const shapes = shapesByPage[pageNum] ?? []
    for (const s of shapes) {
      const dragged = dragShapeRef.current && s.id === dragShapeRef.current.id ? { ...s, start: dragShapeRef.current.start, end: dragShapeRef.current.end } : s
      drawShape(ctx, dragged, w, h, false)
    }

    // preview current shape being drawn
    const preview = shapePreviewRef.current
    if (preview && preview.page === pageNum) {
      drawShape(ctx, preview, w, h, true)
    }

    // selection highlight (Figma tarzı: kesikli çerçeve + köşe tutamaçları)
    if (selectedShapeId && !isDrawingRef.current) {
      const sel = dragShapeRef.current?.id === selectedShapeId && dragShapeRef.current
        ? shapes.find(s => s.id === selectedShapeId)
        : shapes.find(s => s.id === selectedShapeId)
      if (sel) {
        const live = dragShapeRef.current && dragShapeRef.current.id === sel.id ? dragShapeRef.current : null
        const x1 = (live ? live.start.x : sel.start.x) * w
        const y1 = (live ? live.start.y : sel.start.y) * h
        const x2 = (live ? live.end.x : sel.end.x) * w
        const y2 = (live ? live.end.y : sel.end.y) * h
        const left = Math.min(x1, x2), right = Math.max(x1, x2)
        const top = Math.min(y1, y2), bottom = Math.max(y1, y2)
        const pad = 4
        ctx.save()
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        ctx.strokeRect(left - pad, top - pad, (right - left) + pad * 2, (bottom - top) + pad * 2)
        ctx.setLineDash([])
        ctx.fillStyle = '#ffffff'
        const hs = 4
        for (const [hx, hy] of [[left - pad, top - pad], [right + pad, top - pad], [left - pad, bottom + pad], [right + pad, bottom + pad]] as [number, number][]) {
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
          ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs)
        }
        ctx.restore()
      }
    }

    // preview current stroke being drawn
    const cur = currentPointsRef.current
    if (isDrawingRef.current && cur.length && (tool === 'pen' || tool === 'dashed-pen')) {
      const isStraight = ctrlRef.current
      const previewDash = tool === 'dashed-pen'
      if (isStraight && cur.length >= 2) {
        const a = cur[0], b = cur[cur.length - 1]
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width
        if (previewDash) ctx.setLineDash([8, 4])
        ctx.lineCap = 'round'
        ctx.moveTo(a.x * w, a.y * h); ctx.lineTo(b.x * w, b.y * h); ctx.stroke()
        ctx.setLineDash([])
      } else if (cur.length > 1 && !previewDash) {
        // normal kalem: perfect-freehand dolgu önizleme
        const input = cur.map(p => ({ x: p.x * w, y: p.y * h, pressure: p.pressure ?? 0.5 }))
        const outline = getStroke(input as never, { size: width * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5 }) as unknown as number[][]
        if (outline.length > 2) { ctx.beginPath(); ctx.fillStyle = color; ctx.globalAlpha = 0.95; ctx.moveTo(outline[0][0], outline[0][1]); for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1 }
      } else if (cur.length > 1 && previewDash) {
        // kesikli kalem: kesikli polyline önizleme
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash([8, 4]); ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        ctx.moveTo(cur[0].x * w, cur[0].y * h)
        for (let i = 1; i < cur.length; i++) ctx.lineTo(cur[i].x * w, cur[i].y * h)
        ctx.stroke(); ctx.setLineDash([])
      }
    }
    if (tool === 'eraser' && cur.length) {
      const last = cur[cur.length - 1]
      ctx.beginPath(); ctx.strokeStyle = 'rgba(239,68,68,0.9)'; ctx.lineWidth = 1.5; ctx.fillStyle = 'rgba(239,68,68,0.15)'
      ctx.arc(last.x * w, last.y * h, width * 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }
  }, [strokesByPage, shapesByPage, pageNum, color, width, tool, shapeFill, lineStyle, selectedShapeId])

  useEffect(() => { drawOverlay() }, [drawOverlay, strokesByPage, shapesByPage])

  const getPos = (e: React.PointerEvent) => {
    const c = drawCanvasRef.current!
    const rect = c.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), pressure: (e as unknown as PointerEvent).pressure || 0.5 }
  }
  // şekil hit-test: nokta şeklin bbox'ında mı (arrow için çizgi mesafesi)
  const hitTestShape = (s: Shape, px: number, py: number, w: number, h: number): boolean => {
    const x1 = s.start.x * w, y1 = s.start.y * h
    const x2 = s.end.x * w, y2 = s.end.y * h
    const pad = Math.max(6, s.width * 2)
    if (s.type === 'arrow') {
      const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2
      const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2)) : 0
      return Math.hypot(x1 + t * (x2 - x1) - px, y1 + t * (y2 - y1) - py) < pad * 1.5
    }
    const left = Math.min(x1, x2), right = Math.max(x1, x2)
    const top = Math.min(y1, y2), bottom = Math.max(y1, y2)
    return px >= left - pad && px <= right + pad && py >= top - pad && py <= bottom + pad
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!pdfDoc) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    isDrawingRef.current = true
    const p = getPos(e)

    const isShapeTool = tool === 'rectangle' || tool === 'ellipse' || tool === 'triangle' || tool === 'arrow'

    if (tool === 'select') {
      const w = viewportW.current, h = viewportH.current
      const shapes = shapesByPage[pageNum] ?? []
      let hit: Shape | null = null
      for (let i = shapes.length - 1; i >= 0; i--) {
        if (hitTestShape(shapes[i], p.x * w, p.y * h, w, h)) { hit = shapes[i]; break }
      }
      if (hit) {
        setSelectedShapeId(hit.id)
        dragShapeRef.current = { id: hit.id, start: { ...hit.start }, end: { ...hit.end } }
        dragGrabRef.current = { px: p.x, py: p.y, s0: { ...hit.start }, e0: { ...hit.end } }
      } else {
        setSelectedShapeId(null)
        dragShapeRef.current = null
        dragGrabRef.current = null
      }
      drawOverlay(); e.preventDefault(); return
    }

    if (isShapeTool) {
      shapeStartRef.current = p
      shapePreviewRef.current = {
        id: Math.random().toString(36).slice(2),
        type: tool as ShapeType,
        start: p,
        end: p,
        color,
        width,
        fill: shapeFill,
        lineStyle,
        page: pageNum,
      }
    } else {
      currentPointsRef.current = [p]
      if (tool === 'eraser') eraseAt(p)
    }
    drawOverlay(); e.preventDefault()
  }
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawingRef.current) return
    const p = getPos(e)
    
    const isShapeTool = tool === 'rectangle' || tool === 'ellipse' || tool === 'triangle' || tool === 'arrow'
    
    // seçili şekli taşı
    if (tool === 'select') {
      const g = dragGrabRef.current
      const d = dragShapeRef.current
      if (g && d) {
        const dx = p.x - g.px, dy = p.y - g.py
        const cl = (v: number) => Math.max(0, Math.min(1, v))
        d.start = { x: cl(g.s0.x + dx), y: cl(g.s0.y + dy) }
        d.end = { x: cl(g.e0.x + dx), y: cl(g.e0.y + dy) }
        drawOverlay()
      }
      return
    }
    
    if (isShapeTool && shapeStartRef.current) {
      // constrain proportions if Ctrl held
      let endX = p.x, endY = p.y
      if (ctrlRef.current) {
        const start = shapeStartRef.current
        const dx = p.x - start.x
        const dy = p.y - start.y
        const absDx = Math.abs(dx), absDy = Math.abs(dy)
        if (absDx > absDy) {
          endY = start.y + (dy > 0 ? absDx : -absDx)
        } else {
          endX = start.x + (dx > 0 ? absDy : -absDy)
        }
      }
      shapePreviewRef.current = {
        ...shapePreviewRef.current!,
        end: { x: endX, y: endY },
        color,
        width,
        fill: shapeFill,
        lineStyle,
      }
    } else {
      const cur = currentPointsRef.current
      const last = cur[cur.length - 1]
      const dist = Math.hypot(p.x - last.x, p.y - last.y)
      if (dist < 0.0005 && cur.length > 2) { drawOverlay(); return }
      cur.push(p)
      if (tool === 'eraser') eraseAt(p)
    }
    drawOverlay()
  }
  const handlePointerUp = () => {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false

    // taşıma commit: sürüklenen şekli yeni konumuyla kalıcılaştır
    if (tool === 'select') {
      const g = dragGrabRef.current
      const d = dragShapeRef.current
      if (g && d && (d.start.x !== g.s0.x || d.start.y !== g.s0.y || d.end.x !== g.e0.x || d.end.y !== g.e0.y)) {
        const prevStrokes = strokesByPage[pageNum] ?? []
        const prevShapes = shapesByPage[pageNum] ?? []
        pushUndo(pageNum, prevStrokes, prevShapes)
        setShapesByPage(s => ({
          ...s,
          [pageNum]: (s[pageNum] ?? []).map(sh => sh.id === d.id ? { ...sh, start: d.start, end: d.end } : sh),
        }))
      }
      dragShapeRef.current = null
      dragGrabRef.current = null
      drawOverlay()
      return
    }

    const isShapeTool = tool === 'rectangle' || tool === 'ellipse' || tool === 'triangle' || tool === 'arrow'
    
    if (isShapeTool) {
      const preview = shapePreviewRef.current
      if (preview && shapeStartRef.current) {
        const start = shapeStartRef.current
        const end = preview.end
        const dist = Math.hypot(end.x - start.x, end.y - start.y)
        if (dist > 0.002) { // minimum size
          const shape: Shape = {
            id: Math.random().toString(36).slice(2),
            type: preview.type,
            start,
            end,
            color: preview.color,
            width: preview.width,
            fill: preview.fill,
            lineStyle: preview.lineStyle,
            page: pageNum,
          }
          const prevStrokes = strokesByPage[pageNum] ?? []
          const prevShapes = shapesByPage[pageNum] ?? []
          pushUndo(pageNum, prevStrokes, prevShapes)
          setShapesByPage(s => ({ ...s, [pageNum]: [...prevShapes, shape] }))
        }
      }
      shapeStartRef.current = null
      shapePreviewRef.current = null
    } else {
      const cur = currentPointsRef.current
      if (tool === 'eraser') { currentPointsRef.current = []; drawOverlay(); return }
      if (cur.length < 1) { currentPointsRef.current = []; return }
      let finalPoints = cur; let straight = false
      if (ctrlRef.current && cur.length >= 2) { finalPoints = [cur[0], cur[cur.length - 1]]; straight = true }
      if (finalPoints.length === 1) finalPoints = [finalPoints[0], { ...finalPoints[0], x: finalPoints[0].x + 0.0001, y: finalPoints[0].y + 0.0001 }]
      const stroke: Stroke = { id: Math.random().toString(36).slice(2), points: finalPoints, color, width, straight, dashed: tool === 'dashed-pen' }
      const prevStrokes = strokesByPage[pageNum] ?? []
      const prevShapes = shapesByPage[pageNum] ?? []
      pushUndo(pageNum, prevStrokes, prevShapes)
      setStrokesByPage(s => ({ ...s, [pageNum]: [...prevStrokes, stroke] }))
      currentPointsRef.current = []
    }
    drawOverlay()
  }
  const eraseAt = (p: Point) => {
    const w = viewportW.current, h = viewportH.current
    const px = p.x * w, py = p.y * h; const radius = width * 3
    const strokes = strokesByPage[pageNum] ?? []
    let changed = false
    const next = strokes.filter(s => {
      for (const pt of s.points) { const sx = pt.x * w, sy = pt.y * h; if (Math.hypot(sx - px, sy - py) < radius) return false }
      if (s.straight && s.points.length >= 2) {
        const a = s.points[0], b = s.points[1]; const ax = a.x * w, ay = a.y * h, bx = b.x * w, by = b.y * h
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2)) : 0
        const projX = ax + t * (bx - ax), projY = ay + t * (by - ay)
        if (Math.hypot(projX - px, projY - py) < radius) return false
      }
      return true
    })
    // also erase shapes
    const shapes = shapesByPage[pageNum] ?? []
    const nextShapes = shapes.filter(s => {
      const x1 = s.start.x * w, y1 = s.start.y * h
      const x2 = s.end.x * w, y2 = s.end.y * h
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2
      if (s.type === 'rectangle') {
        const x = Math.min(x1, x2), y = Math.min(y1, y2)
        const wRect = Math.abs(x2 - x1), hRect = Math.abs(y2 - y1)
        return px < x - radius || px > x + wRect + radius || py < y - radius || py > y + hRect + radius
      } else if (s.type === 'ellipse') {
        return Math.hypot((px - cx) / Math.max(1, rx), (py - cy) / Math.max(1, ry)) > 1 + radius / Math.max(rx, ry)
      } else if (s.type === 'triangle' || s.type === 'arrow') {
        return Math.hypot(px - cx, py - cy) > Math.max(rx, ry) + radius
      }
      return true
    })
    if (next.length !== strokes.length || nextShapes.length !== shapes.length) changed = true
    if (changed) {
      pushUndo(pageNum, strokes, shapes)
      setStrokesByPage(s => ({ ...s, [pageNum]: next }))
      setShapesByPage(s => ({ ...s, [pageNum]: nextShapes }))
    }
  }

  const undo = useCallback(() => {
    const stack = undoStacks[pageNum]
    if (!stack?.length) return
    const prev = stack[stack.length - 1]
    const cur = { strokes: strokesByPage[pageNum] ?? [], shapes: shapesByPage[pageNum] ?? [] }
    setUndoStacks(s => ({ ...s, [pageNum]: s[pageNum].slice(0, -1) }))
    setRedoStacks(s => ({ ...s, [pageNum]: [...(s[pageNum] ?? []), cur] }))
    setStrokesByPage(s => ({ ...s, [pageNum]: prev.strokes }))
    setShapesByPage(s => ({ ...s, [pageNum]: prev.shapes }))
  }, [undoStacks, pageNum, strokesByPage, shapesByPage])
  const redo = useCallback(() => {
    const stack = redoStacks[pageNum]
    if (!stack?.length) return
    const nxt = stack[stack.length - 1]
    const cur = { strokes: strokesByPage[pageNum] ?? [], shapes: shapesByPage[pageNum] ?? [] }
    setRedoStacks(s => ({ ...s, [pageNum]: s[pageNum].slice(0, -1) }))
    setUndoStacks(s => ({ ...s, [pageNum]: [...(s[pageNum] ?? []), cur] }))
    setStrokesByPage(s => ({ ...s, [pageNum]: nxt.strokes }))
    setShapesByPage(s => ({ ...s, [pageNum]: nxt.shapes }))
  }, [redoStacks, pageNum, strokesByPage, shapesByPage])
  const clear = useCallback(() => {
    const curStrokes = strokesByPage[pageNum] ?? []
    const curShapes = shapesByPage[pageNum] ?? []
    if (!curStrokes.length && !curShapes.length) return
    setConfirmClearOpen(true)
  }, [strokesByPage, shapesByPage, pageNum, pushUndo])
  const doClear = useCallback(() => {
    pushUndo(pageNum, strokesByPage[pageNum] ?? [], shapesByPage[pageNum] ?? [])
    setStrokesByPage(s => ({ ...s, [pageNum]: [] }))
    setShapesByPage(s => ({ ...s, [pageNum]: [] }))
    setSelectedShapeId(null)
    setConfirmClearOpen(false)
  }, [strokesByPage, shapesByPage, pageNum, pushUndo])

  const handleSave = useCallback(async () => {
    if (!pdfBytes || !pdfDoc) return
    setSaving(true)
    try {
      const { PDFDocument, rgb } = await import('pdf-lib')
      let libDoc: Awaited<ReturnType<typeof PDFDocument.load>>

      // 1) normal yol: orijinali vektör olarak aç
      try {
        libDoc = await PDFDocument.load(pdfBytes)
      } catch (err) {
        if (!/encrypted/i.test(String((err as Error)?.message))) throw err

        // 2) şifreli PDF: pdf.js decrypt edebildiği için sayfaları görselleştir,
        //    yeni bir PDF kur ve açıklamaları üstüne vektör olarak bas
        libDoc = await PDFDocument.create()
        const RENDER_SCALE = 2
        for (let i = 1; i <= totalPages; i++) {
          const p = await pdfDoc.getPage(i)
          const base = p.getViewport({ scale: 1 })
          const vp = p.getViewport({ scale: RENDER_SCALE })
          const c = document.createElement('canvas')
          c.width = Math.round(vp.width); c.height = Math.round(vp.height)
          const c2d = c.getContext('2d', { alpha: false })!
          c2d.fillStyle = '#ffffff'; c2d.fillRect(0, 0, c.width, c.height)
          await p.render({ canvasContext: c2d as unknown as CanvasRenderingContext2D, viewport: vp } as never).promise
          const img = await libDoc.embedJpg(c.toDataURL('image/jpeg', 0.85))
          const np = libDoc.addPage([base.width, base.height])
          np.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height })
          c.width = 0; c.height = 0 // bellek: ara canvas'ı hemen serbest bırak
        }
      }

      // açıklamaları (strokes + shapes) hedef belgeye uygula — her iki yolda da aynı kod
      const applyAnnotations = (doc: Awaited<ReturnType<typeof PDFDocument.load>>) => {
      // save strokes
      for (const [pageKey, strokes] of Object.entries(strokesByPage)) {
        const pn = Number(pageKey); if (!strokes.length) continue
        const page = doc.getPage(pn - 1)
        const { width: pw, height: ph } = page.getSize()
        for (const s of strokes) {
          const v = hexToRgbVals(s.color)
          const c = rgb(v.r, v.g, v.b)
          const lw = Math.max(1, s.width * (pw / viewportW.current || 1) * 0.6)
          if ((s.straight || s.dashed) && s.points.length >= 2) {
            // düz veya kesikli: stroke olarak göm (dash varsa borderDashArray)
            const dash = s.dashed ? { borderDashArray: [6, 4], borderDashPhase: 0 } : {}
            if (s.straight && s.points.length === 2) {
              const a = s.points[0], b = s.points[s.points.length - 1]
              page.drawLine({ start: { x: a.x * pw, y: ph - a.y * ph }, end: { x: b.x * pw, y: ph - b.y * ph }, thickness: lw, color: c, opacity: 1, ...dash })
            } else {
              // kesikli serbest yol: noktaları polyline path olarak göm
              const pts = s.points.map(p => [p.x * pw, p.y * ph] as [number, number])
              let path = `M ${pts[0][0]} ${pts[0][1]}`
              for (let i = 1; i < pts.length; i++) path += ` L ${pts[i][0]} ${pts[i][1]}`
              try {
                // anchor y=ph: kütüphane page_y = ph - svg_y hesaplar → canvas konumuyla birebir
                page.drawSvgPath(path, { x: 0, y: ph, borderColor: c, borderWidth: lw, borderOpacity: 1, color: undefined, ...dash })
              } catch {
                for (let i = 0; i < pts.length - 1; i++) page.drawLine({ start: { x: pts[i][0], y: pts[i][1] }, end: { x: pts[i + 1][0], y: pts[i + 1][1] }, thickness: lw, color: c, opacity: 1, ...dash })
              }
            }
          } else {
            const input = s.points.map(p => ({ x: p.x * viewportW.current, y: p.y * viewportH.current, pressure: p.pressure }))
            const outline = getStroke(input as never, { size: s.width * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5 }) as unknown as number[][]
            if (!outline.length) continue
            // drawSvgPath kendi y-flip'ini yapıyor → canvas koordinatını aynen ver (çift flip yasak!)
            const sx = pw / (viewportW.current || pw), sy = ph / (viewportH.current || ph)
            const pdfOutline = outline.map(([x, y]) => [x * sx, y * sy] as [number, number])
            const path = getSvgPath(pdfOutline); if (!path) continue
            const v2 = hexToRgbVals(s.color); const c2 = rgb(v2.r, v2.g, v2.b)
            try { page.drawSvgPath(path, { x: 0, y: ph, color: c2, borderColor: c2, borderWidth: 0, opacity: 1 }) } catch {
              for (let i = 0; i < pdfOutline.length - 1; i++) page.drawLine({ start: { x: pdfOutline[i][0], y: ph - pdfOutline[i][1] }, end: { x: pdfOutline[i + 1][0], y: ph - pdfOutline[i + 1][1] }, thickness: 0.5, color: c2 })
            }
          }
        }
      }
      // save shapes
      for (const [pageKey, shapes] of Object.entries(shapesByPage)) {
        const pn = Number(pageKey); if (!shapes.length) continue
        const page = doc.getPage(pn - 1)
        const { width: pw, height: ph } = page.getSize()
        for (const s of shapes) {
          const v = hexToRgbVals(s.color)
          const c = rgb(v.r, v.g, v.b)
          const lw = Math.max(1, s.width * (pw / viewportW.current || 1) * 0.6)
          // yüksek seviye metotlar kendi dash state'ini sıfırladığı için dash'i opsiyon olarak ver
          const dash = s.lineStyle === 'dashed' ? { borderDashArray: [6, 4], borderDashPhase: 0 } : {}
          const x1 = s.start.x * pw, y1 = ph - s.start.y * ph
          const x2 = s.end.x * pw, y2 = ph - s.end.y * ph
          const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
          const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y1 - y2) / 2

          if (s.type === 'rectangle') {
            const x = Math.min(x1, x2), y = Math.min(y1, y2)
            page.drawRectangle({
              x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
              color: s.fill ? c : undefined,
              borderColor: c, borderWidth: lw,
              opacity: s.fill ? 0.3 : 1, borderOpacity: 1,
              ...dash,
            })
          } else if (s.type === 'ellipse') {
            page.drawEllipse({
              x: cx, y: cy, xScale: rx, yScale: ry,
              color: s.fill ? c : undefined,
              borderColor: c, borderWidth: lw,
              opacity: s.fill ? 0.3 : 1, borderOpacity: 1,
              ...dash,
            })
            } else if (s.type === 'triangle') {
              const left = Math.min(x1, x2), right = Math.max(x1, x2)
              const top = Math.min(y1, y2), bottom = Math.max(y1, y2)
              // anchor y=ph + kütüphane flip'i = canvas konumu; apex üstte kalır
              const path = `M ${(left + right) / 2} ${top} L ${right} ${bottom} L ${left} ${bottom} Z`
              page.drawSvgPath(path, {
                x: 0, y: ph,
                borderColor: c, borderWidth: lw,
                color: s.fill ? c : undefined,
                opacity: s.fill ? 0.3 : 0,
                borderOpacity: 1,
                ...dash,
              })
            } else if (s.type === 'arrow') {
              const angle = Math.atan2(y1 - y2, x2 - x1)
              const headLen = Math.max(lw * 4, 15)
              page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: lw, color: c, opacity: 1, ...dash })
              const hx1 = x2 - headLen * Math.cos(angle - Math.PI / 6)
              const hy1 = y2 + headLen * Math.sin(angle - Math.PI / 6)
              const hx2 = x2 - headLen * Math.cos(angle + Math.PI / 6)
              const hy2 = y2 + headLen * Math.sin(angle + Math.PI / 6)
              page.drawLine({ start: { x: x2, y: y2 }, end: { x: hx1, y: hy1 }, thickness: lw, color: c, opacity: 1, ...dash })
              page.drawLine({ start: { x: x2, y: y2 }, end: { x: hx2, y: hy2 }, thickness: lw, color: c, opacity: 1, ...dash })
            }
        }
      }
      }
      applyAnnotations(libDoc)

      const out = await libDoc.save()
      const blob = new Blob([out as unknown as BlobPart], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = fileName.replace(/\.pdf$/i, '_isaretli.pdf'); a.click(); URL.revokeObjectURL(url)
    } catch (e) { console.error(e); alert('Kaydetme hatası: ' + (e as Error).message) } finally { setSaving(false) }
  }, [pdfBytes, strokesByPage, shapesByPage, fileName])

  const totalStrokes = Object.values(strokesByPage).reduce((a, b) => a + b.length, 0)

  useEffect(() => { if (pageEditing) pageInputRef.current?.focus() }, [pageEditing])
  useEffect(() => { if (zoomEditing) zoomInputRef.current?.focus() }, [zoomEditing])
  useEffect(() => { if (!pageEditing) setPageInput(String(pageNum)) }, [pageNum, pageEditing])

  const commitPage = useCallback((raw: string) => {
    const n = parseInt(raw, 10)
    if (Number.isNaN(n)) { setPageEditing(false); return }
    const clamped = Math.max(1, Math.min(totalPages || 1, n))
    setPageNum(clamped); setPageEditing(false)
    // scroll thumb into view
    setTimeout(() => {
      const el = thumbScrollRef.current
      if (el) {
        const idx = clamped - 1
        const top = idx * ITEM_H
        if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - ITEM_H) el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ITEM_H / 2)
      }
    }, 50)
  }, [totalPages])
  const commitZoom = useCallback((raw: string) => {
    const n = parseInt(raw.replace('%',''), 10)
    if (Number.isNaN(n)) { setZoomEditing(false); return }
    const clamped = Math.max(60, Math.min(400, n))
    setScale(clamped/100); setZoomEditing(false)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const dir = e.deltaY < 0 ? 1 : -1
        setScale(s => { const ns = Math.round((s + dir*0.08)*100)/100; return Math.max(0.6, Math.min(4, ns)) })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel as any)
  }, [])

  useEffect(() => {
    const isInput = () => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    }
    const h = (e: KeyboardEvent) => {
      if (isInput()) { if (e.key === 'Escape') (document.activeElement as HTMLElement).blur(); return }
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if ((mod && key === 'y') || (mod && e.shiftKey && key === 'z')) { e.preventDefault(); redo(); return }
      if (mod && key === 's') { e.preventDefault(); if (pdfDoc && totalStrokes>0 && !saving) handleSave(); return }
      if (mod && e.key === '0') { e.preventDefault(); setScale(1); return }
      if (!mod && (key === 'b' || key === 'p')) { setTool('pen'); return }
      if (!mod && key === 'd') { setTool('dashed-pen'); return }
      if (!mod && key === 'v') { setTool('select'); return }
      if (!mod && key === 'e') { setTool('eraser'); return }
      if (!mod && key === 'r') { setTool('rectangle'); return }
      if (!mod && key === 'o') { setTool('ellipse'); return }
      if (!mod && key === 't') { setTool('triangle'); return }
      if (!mod && key === 'a') { setTool('arrow'); return }
      if (!mod && e.key === 'Escape') { setSelectedShapeId(null); drawOverlay(); return }
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        const curStrokes = strokesByPage[pageNum] ?? []
        const curShapes = shapesByPage[pageNum] ?? []
        // önce seçili şekil, yoksa son eklenen
        if (selectedShapeId && curShapes.some(s => s.id === selectedShapeId)) {
          e.preventDefault()
          pushUndo(pageNum, curStrokes, curShapes)
          setShapesByPage(s=>({...s,[pageNum]:curShapes.filter(s=>s.id!==selectedShapeId)}))
          setSelectedShapeId(null)
          return
        }
        if (curStrokes.length || curShapes.length) {
          e.preventDefault()
          if (curShapes.length) {
            const next = curShapes.slice(0, -1)
            pushUndo(pageNum, curStrokes, curShapes)
            setShapesByPage(s=>({...s,[pageNum]:next}))
          } else if (curStrokes.length) {
            const next = curStrokes.slice(0, -1)
            pushUndo(pageNum, curStrokes, curShapes)
            setStrokesByPage(s=>({...s,[pageNum]:next}))
          }
        }
        return
      }
      if (!mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setScale(s=>Math.min(4, Math.round((s+0.12)*100)/100)); return }
      if (!mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); setScale(s=>Math.max(0.6, Math.round((s-0.12)*100)/100)); return }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [undo, redo, pdfDoc, totalStrokes, saving, handleSave, pageNum, strokesByPage, shapesByPage, pushUndo, selectedShapeId])

  // click outside to close popovers
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-popover]') && !t.closest('[data-trigger]')) { setShowColor(false); setShowWidth(false); setShowFill(false); setShowLineStyle(false) }
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  // virtualization range
  const startIdx = Math.max(0, Math.floor(thumbScrollTop / ITEM_H) - 3)
  const endIdx = Math.min(totalPages, Math.ceil((thumbScrollTop + thumbViewportH) / ITEM_H) + 3)

  // toolbar — profesyonel koyu, sadece outline ikonlar, eşit aralık
  const TB_BG = '#0f1115'
  const TB_BORDER = '#1e232e'
  const TB_MUTED = '#8a909e'
  const TB_ACTIVE_BG = '#1e232e'
  const TB_ACTIVE_BORDER = '#2a3449'

  const tBtn = (active?: boolean, disabled?: boolean): React.CSSProperties => ({
    width: 32, height: 32, borderRadius: 8, border: `1px solid ${active ? TB_ACTIVE_BORDER : 'transparent'}`,
    background: active ? TB_ACTIVE_BG : 'transparent',
    color: active ? '#e5e7eb' : TB_MUTED,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    opacity: disabled ? 0.35 : 1, pointerEvents: disabled ? 'none' as any : undefined,
    transition: 'background 120ms, border-color 120ms, color 120ms'
  })

  // popover satır stili (Kalınlık popover'ı ile aynı desen) — yükseklik class'tan (h-8)
  const popRow = (active: boolean): React.CSSProperties => ({
    background: active ? '#242a38' : 'transparent',
    borderColor: active ? '#2e3447' : 'transparent',
    color: active ? '#e5e7eb' : '#8a909e',
  })

  // sidebar toggle left position
  const sidebarLeft = showThumbs ? 220 : 0

  // sidebar toggle icon renderer using arrow function
  const SidebarToggleIcon = () => (showThumbs ? <ChevronLeft size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />)

  // zoom input/button component to avoid parser issues with complex conditional
  return (
    <div className="h-[100dvh] flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* PROFESYONEL TOOLBAR — sıfırdan, koyu, sadece ikon, eşit boşluk, Lucide tek set */}
      <header className="sticky top-0 z-30 flex items-center h-[40px] px-2 gap-1 border-b shrink-0 select-none" style={{ background: TB_BG, borderColor: TB_BORDER }}>
        {/* left: panel + file */}
        {/* 1 Dosya Aç */}
        <label title="Dosya Aç" className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer border border-transparent text-[#8a909e] hover:bg-[#1a1f2b] hover:text-[#e5e7eb] hover:border-[#1e232e] transition-colors shrink-0">
          <FolderOpen size={16} strokeWidth={1.7} />
          <input type="file" accept="application/pdf" className="hidden" onChange={e=>{ const input=e.currentTarget; const f=input.files?.[0]; if(f) onFile(f).finally(()=>{input.value=''}); else input.value=''}} />
        </label>
        {/* 2 Seç/Taşı */}
        <button title="Seç / Taşı (V)" onClick={()=>{setTool('select'); setSelectedShapeId(null)}} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='select')}><MousePointer2 size={16} strokeWidth={1.7} /></button>
        {/* 3 Kalem */}
        <button title="Kalem (B/P)" onClick={()=>setTool('pen')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='pen')}><Pencil size={16} strokeWidth={1.7} /></button>
        {/* 3 Silgi */}
        <button title="Silgi (E)" onClick={()=>setTool('eraser')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='eraser')}><Eraser size={16} strokeWidth={1.7} /></button>
        {/* Kesikli Kalem */}
        <button title="Kesikli Kalem (D)" onClick={()=>setTool('dashed-pen')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='dashed-pen')}><Minus size={16} strokeWidth={1.7} /></button>
        {/* 4 Renk */}
        <div className="relative shrink-0" data-popover>
          <button title="Renk" onClick={()=>{setShowColor(v=>!v); setShowWidth(false)}} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(showColor)} data-trigger>
            <span className="flex items-center gap-1">
              <Palette size={16} strokeWidth={1.7} />
              <span className="w-2 h-2 rounded-full border" style={{ background: color, borderColor: '#ffffff30' }} />
            </span>
          </button>
          {showColor && (
            <div className="absolute left-0 top-[40px] p-2.5 rounded-xl border shadow-xl flex flex-col gap-2.5 z-40" style={{ background:'#151a23', borderColor:'#232a3b', minWidth: 176 }}>
              <div className="grid grid-cols-5 gap-1.5">
                {COLORS.map(c=>(
                  <button key={c} onClick={()=>{setColor(c); setTool('pen'); setShowColor(false)}} className="w-7 h-7 rounded-full border-2 transition" style={{ background:c, borderColor: color===c ? '#fff' : '#ffffff18', boxShadow: color===c? '0 0 0 2px #3b82f6' : undefined }} />
                ))}
              </div>
              <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg border cursor-pointer" style={{ background:'#0f1115', borderColor:'#232a3b' }}>
                <span className="text-[11px] font-medium" style={{ color: '#e5e7eb' }}>Özel</span>
                <input type="color" value={color} onChange={e=>{setColor(e.target.value); setTool('pen')}} className="ml-auto w-7 h-7 rounded border-0 p-0 bg-transparent cursor-pointer" />
              </label>
            </div>
          )}
        </div>
        {/* 5 Kalınlık */}
        <div className="relative shrink-0" data-popover>
          <button title="Kalınlık" onClick={()=>{setShowWidth(v=>!v); setShowColor(false)}} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(showWidth)} data-trigger>
            <SlidersHorizontal size={16} strokeWidth={1.7} />
          </button>
          {showWidth && (
            <div className="absolute left-0 top-[40px] p-3 rounded-xl border shadow-xl flex flex-col gap-3 z-40" style={{ background:'#151a23', borderColor:'#232a3b', minWidth: 200 }}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium" style={{ color:'#e5e7eb' }}>Kalınlık</span>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded border" style={{ background:'#0f1115', borderColor:'#232a3b', color:'#e5e7eb' }}>{width.toFixed(1)}</span>
              </div>
              <input type="range" min={0.5} max={10} step={0.5} value={width} onChange={e=>setWidth(parseFloat(e.target.value))} className="w-full h-1.5 rounded-lg appearance-none cursor-pointer" style={{ accentColor:'#3b82f6', background:'#1e232e' }} />
              <div className="flex justify-between text-[10px]" style={{ color:'#8a909e' }}><span>0.5</span><span>10</span></div>
              <div className="flex items-center justify-center h-10 rounded-lg border" style={{ background:'#0a0e14', borderColor:'#1e232e' }}>
                <span className="rounded-full transition-all" style={{ width: Math.max(3, width*2.2+4), height: Math.max(3, width*2.2+4), background: color, opacity:0.95 }} />
              </div>
              <div className="text-[10px] text-center" style={{ color:'#6b7280' }}>Kalem ve silgi için ortak</div>
            </div>
          )}
        </div>
        {/* 6 Geri Al */}
        <button title="Geri Al (Ctrl+Z)" onClick={undo} disabled={!canUndo} className="w-8 h-8 rounded-lg flex items-center justify-center border border-transparent transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e] hover:text-[#e5e7eb] disabled:opacity-30 disabled:pointer-events-none" style={tBtn(false, !canUndo)}><Undo2 size={16} strokeWidth={1.7} /></button>
        {/* 7 İleri Al */}
        <button title="İleri Al (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo} className="w-8 h-8 rounded-lg flex items-center justify-center border border-transparent transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e] hover:text-[#e5e7eb] disabled:opacity-30 disabled:pointer-events-none" style={tBtn(false, !canRedo)}><Redo2 size={16} strokeWidth={1.7} /></button>
        {/* 8 Temizle */}
        <button title="Temizle" onClick={clear} disabled={totalStrokes===0} className="w-8 h-8 rounded-lg flex items-center justify-center border border-transparent transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e] hover:text-[#e5e7eb] disabled:opacity-30 disabled:pointer-events-none" style={tBtn(false, totalStrokes===0)}><Trash2 size={16} strokeWidth={1.7} /></button>
        {/* Şekil Araçları */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-[10px] border" style={{ background:'#0a0e14', borderColor:'#1e232e' }}>
          <button title="Dikdörtgen (R)" onClick={()=>setTool('rectangle')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='rectangle')}><Square size={16} strokeWidth={1.7} /></button>
          <button title="Elips/Daire (O)" onClick={()=>setTool('ellipse')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='ellipse')}><Circle size={16} strokeWidth={1.7} /></button>
          <button title="Üçgen (T)" onClick={()=>setTool('triangle')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='triangle')}><Triangle size={16} strokeWidth={1.7} /></button>
          <button title="Ok (A)" onClick={()=>setTool('arrow')} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(tool==='arrow')}><ArrowRight size={16} strokeWidth={1.7} /></button>
        </div>
        {/* Dolu/Çerçeve */}
        <div className="relative shrink-0" data-popover>
          <button title="Dolu/Çerçeve" onClick={()=>{setShowFill(v=>!v); setShowLineStyle(false)}} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(showFill)} data-trigger>
            {shapeFill ? <Square size={16} strokeWidth={1.7} /> : <SquareDashed size={16} strokeWidth={1.7} />}
          </button>
          {showFill && (
            <div className="absolute left-0 top-[40px] p-2 rounded-xl border shadow-xl flex flex-col gap-1 z-40" style={{ background:'#151a23', borderColor:'#232a3b', minWidth: 140 }}>
              <button onClick={()=>{setShapeFill(true); setShowFill(false)}} className="h-8 rounded-lg flex items-center gap-2.5 px-2.5 border text-[12px] font-medium transition-colors" style={popRow(shapeFill)}>
                <Square size={14} strokeWidth={2} />
                <span>Dolu</span>
                {shapeFill && <span className="ml-auto text-[10px]" style={{ color:'#3b82f6' }}>✓</span>}
              </button>
              <button onClick={()=>{setShapeFill(false); setShowFill(false)}} className="h-8 rounded-lg flex items-center gap-2.5 px-2.5 border text-[12px] font-medium transition-colors" style={popRow(!shapeFill)}>
                <SquareDashed size={14} strokeWidth={2} />
                <span>Çerçeve</span>
                {!shapeFill && <span className="ml-auto text-[10px]" style={{ color:'#3b82f6' }}>✓</span>}
              </button>
            </div>
          )}
        </div>
        {/* Çizgi Tipi */}
        <div className="relative shrink-0" data-popover>
          <button title="Çizgi Tipi" onClick={()=>{setShowLineStyle(v=>!v); setShowFill(false)}} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(showLineStyle)} data-trigger>
            {lineStyle === 'solid' ? <Minus size={16} strokeWidth={1.7} /> : <SquareDashed size={16} strokeWidth={1.7} />}
          </button>
          {showLineStyle && (
            <div className="absolute left-0 top-[40px] p-2 rounded-xl border shadow-xl flex flex-col gap-1 z-40" style={{ background:'#151a23', borderColor:'#232a3b', minWidth: 140 }}>
              <button onClick={()=>{setLineStyle('solid'); setShowLineStyle(false)}} className="h-8 rounded-lg flex items-center gap-2.5 px-2.5 border text-[12px] font-medium transition-colors" style={popRow(lineStyle==='solid')}>
                <Minus size={14} strokeWidth={2} />
                <span>Düz</span>
                {lineStyle==='solid' && <span className="ml-auto text-[10px]" style={{ color:'#3b82f6' }}>✓</span>}
              </button>
              <button onClick={()=>{setLineStyle('dashed'); setShowLineStyle(false)}} className="h-8 rounded-lg flex items-center gap-2.5 px-2.5 border text-[12px] font-medium transition-colors" style={popRow(lineStyle==='dashed')}>
                <SquareDashed size={14} strokeWidth={2} />
                <span>Kesikli</span>
                {lineStyle==='dashed' && <span className="ml-auto text-[10px]" style={{ color:'#3b82f6' }}>✓</span>}
              </button>
            </div>
          )}
        </div>
        {/* 9 Ayırıcı */}
        <div className="w-px h-5 mx-1 shrink-0" style={{ background: TB_BORDER }} />
        {/* 10 Sol panel */}
        <button title="Sol panel" onClick={()=>setShowThumbs(v=>!v)} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e]" style={tBtn(showThumbs)} data-trigger><PanelLeft size={16} strokeWidth={1.7} /></button>
        {/* 11 Zoom */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button title="Uzaklaştır" onClick={()=>setScale(s=>Math.max(0.6,Math.round((s-0.12)*100)/100))} className="w-8 h-8 rounded-lg flex items-center justify-center border border-transparent text-[#8a909e] hover:bg-[#1a1f2b] hover:text-[#e5e7eb] hover:border-[#1e232e] transition-colors"><ZoomOut size={16} strokeWidth={1.7} /></button>
          {zoomEditing ? (
            <input ref={zoomInputRef} value={zoomInput} onChange={e=>setZoomInput(e.target.value)} onBlur={()=>commitZoom(zoomInput)} onKeyDown={e=>{ if(e.key==='Enter') commitZoom(zoomInput); if(e.key==='Escape') setZoomEditing(false)}}
              className="w-[56px] h-7 text-center rounded-lg border text-xs font-medium outline-none" style={{ background:'#0a0e14', borderColor:'#3b82f6', color: '#e5e7eb' }} />
          ) : (
            <button onClick={()=>{ setZoomInput(String(Math.round(scale*100))); setZoomEditing(true)}} className="h-7 min-w-[56px] px-1.5 rounded-lg border text-xs font-medium hover:bg-[#1a1f2b] transition-colors" style={{ background:'#0a0e14', borderColor:'#1e232e', color: '#e5e7eb' }} title="Zoom">{Math.round(scale*100)}%</button>
          )}
          <button title="Yakınlaştır" onClick={()=>setScale(s=>Math.min(4,Math.round((s+0.12)*100)/100))} className="w-8 h-8 rounded-lg flex items-center justify-center border border-transparent text-[#8a909e] hover:bg-[#1a1f2b] hover:text-[#e5e7eb] hover:border-[#1e232e] transition-colors"><ZoomIn size={16} strokeWidth={1.7} /></button>
        </div>
        {/* 12 İndir */}
        <button title="İndir (Ctrl+S)" onClick={handleSave} disabled={!pdfDoc || saving || totalStrokes===0} className="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0 hover:bg-[#1a1f2b] hover:border-[#1e232e] disabled:opacity-30 disabled:pointer-events-none" style={tBtn(false, !pdfDoc || saving || totalStrokes===0)}><Download size={16} strokeWidth={1.7} /></button>
        {/* 13 Tema */}
        <button title="Tema değiştir" onClick={()=>setTheme(t=>t==='dark'?'light':'dark')} className="w-8 h-8 rounded-lg flex items-center justify-center border border-transparent text-[#8a909e] hover:bg-[#1a1f2b] hover:text-[#e5e7eb] hover:border-[#1e232e] transition-colors shrink-0" style={tBtn(false)}>{theme==='dark'?<Sun size={16} strokeWidth={1.7} />:<Moon size={16} strokeWidth={1.7} />}</button>
      </header>

      {/* body: left thumbs + main */}
      <div className="flex h-[calc(100dvh-40px)] min-h-0 relative">
        {/* Sol panel aç/kapat - her zaman görünür, modern minimal tab (fixed) */}
        <button
          onClick={()=>setShowThumbs(v=>!v)}
          title={showThumbs ? 'Paneli kapat' : 'Paneli aç'}
          aria-label={showThumbs ? 'Paneli kapat' : 'Paneli aç'}
          className="fixed top-1/2 -translate-y-1/2 z-30 w-[20px] h-[64px] flex items-center justify-center rounded-r-[8px] border-y border-r shadow-md hover:shadow-lg transition-all duration-200"
          style={{ left: sidebarLeft, background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          <SidebarToggleIcon />
        </button>
        {/* LEFT THUMB PANEL */}
        <aside className={`shrink-0 border-r flex flex-col overflow-hidden h-full transition-all duration-200 ${showThumbs ? 'w-[220px]' : 'w-0 border-transparent'}`} style={{ background:'var(--bg-card)', borderColor:'var(--border)' }}>
          <div className="h-9 flex items-center justify-between px-3 border-b shrink-0" style={{ borderColor:'var(--border)', background:'var(--bg-card)' }}>
            <span className="text-[12px] font-semibold" style={{ color:'var(--text)' }}>Sayfalar</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded-full border" style={{ background:'var(--bg)', borderColor:'var(--border)', color:'var(--text-muted)' }}>{totalPages}</span>
          </div>
          <div ref={thumbScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain" style={{ background:'var(--bg)', overscrollBehavior: 'contain' as any }} onWheel={e=>e.stopPropagation()} onTouchMove={e=>e.stopPropagation()}>
            {pdfDoc ? (
              <div className="relative" style={{ height: totalPages * ITEM_H }}>
                {Array.from({ length: endIdx - startIdx }, (_, i) => {
                  const idx = startIdx + i
                  const p = idx + 1
                  return (
                    <div key={p} className="absolute left-0 right-0 px-2" style={{ top: idx * ITEM_H, height: ITEM_H }}>
                      <ThumbItem pageNum={p} pdfDoc={pdfDoc} isActive={p===pageNum} onClick={()=>setPageNum(p)} />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="p-6 text-center text-xs" style={{ color:'var(--text-muted)' }}>PDF yükleyin</div>
            )}
          </div>
        </aside>

        {/* MAIN */}
        <div className="flex-1 flex flex-col min-w-0 h-full">
          {/* pagination bar (keep as second row, light) */}
          {pdfDoc && (
            <div className="h-9 flex items-center justify-center gap-2 px-3 border-b shrink-0" style={{ background:'var(--bg-card)', borderColor:'var(--border)' }}>
              <button onClick={()=>setPageNum(p=>Math.max(1,p-1))} disabled={pageNum<=1} className="w-7 h-7 rounded-lg border flex items-center justify-center text-xs disabled:opacity-30" style={{ background:'var(--bg)', borderColor:'var(--border)', color:'var(--text)' }}><ChevronLeft size={14} strokeWidth={1.9} /></button>
              {pageEditing ? (
                <input ref={pageInputRef} value={pageInput} onChange={e=>setPageInput(e.target.value)} onBlur={()=>commitPage(pageInput)} onKeyDown={e=>{ if(e.key==='Enter') commitPage(pageInput); if(e.key==='Escape') setPageEditing(false)}}
                  className="w-[52px] h-7 text-center rounded-lg border text-[13px] font-medium outline-none" style={{ background:'var(--bg)', borderColor:'var(--accent)', color:'var(--text)' }} />
              ) : (
                <button onClick={()=>{ setPageInput(String(pageNum)); setPageEditing(true)}} className="h-7 px-2.5 rounded-lg border text-[13px] font-medium flex items-center gap-1" style={{ background:'var(--bg)', borderColor:'var(--border)', color:'var(--text)' }}>
                  <span className="font-semibold">{pageNum}</span><span style={{ color:'var(--text-muted)' }}>/ {totalPages}</span>
                </button>
              )}
              <button onClick={()=>setPageNum(p=>Math.min(totalPages,p+1))} disabled={pageNum>=totalPages} className="w-7 h-7 rounded-lg border flex items-center justify-center text-xs disabled:opacity-30" style={{ background:'var(--bg)', borderColor:'var(--border)', color:'var(--text)' }}><ChevronRight size={14} strokeWidth={1.9} /></button>
              <span className="hidden sm:inline text-xs ml-2" style={{ color:'var(--text-muted)' }}>{totalStrokes} çizim • Ctrl+Scroll zoom</span>
            </div>
          )}

          <div ref={containerRef} className="flex-1 min-h-0 overflow-auto" style={{ background: 'var(--canvas-bg)', overscrollBehavior: 'contain' }}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={async e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') await onFile(f); else alert('Lütfen PDF bırakın') }}
          >
            <div className="flex flex-col items-center gap-4 p-3 sm:p-6">
            {!pdfDoc ? (
              <div className="w-full max-w-[640px] mt-8 sm:mt-14">
                <div className={`rounded-[16px] border p-8 sm:p-10 text-center transition ${dragOver ? 'scale-[1.01]' : ''}`} style={{ background: 'var(--bg-card)', borderColor: dragOver ? 'var(--accent)' : 'var(--border)', boxShadow: 'var(--shadow)', borderStyle: dragOver?'solid':'dashed', borderWidth: 1.5 }}>
                  <div className="w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-4" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color:'var(--text-muted)' }}>◧</div>
                  <h1 className="text-[22px] font-semibold tracking-tight mb-2">PDF üzerine çizim yap</h1>
                  <p className="text-[13px] leading-relaxed mb-6 max-w-[520px] mx-auto" style={{ color: 'var(--text-muted)' }}>Sürükleyip bırak, işaretle, indir. 100+ sayfada bile hızlı — thumbnail paneli lazy & virtual.</p>
                  <label className="inline-flex items-center gap-2 h-9 px-5 rounded-lg text-white text-[13px] font-semibold cursor-pointer border" style={{ background: 'var(--accent)', borderColor:'var(--accent)' }}>
                    PDF Seç
                    <input type="file" accept="application/pdf" className="hidden" onChange={e => { const input = e.currentTarget; const f = input.files?.[0]; if (f) onFile(f).finally(() => { input.value = '' }); else input.value = '' }} />
                  </label>
                  {loading && <p className="mt-4 text-sm font-medium" style={{ color: 'var(--accent)' }}>Yükleniyor…</p>}
                </div>
              </div>
            ) : (
              <div className="relative rounded-xl overflow-hidden border shrink-0" style={{ boxShadow: 'var(--shadow)', background: 'white', borderColor:'var(--border)' }}>
                <canvas ref={pdfCanvasRef} className="block" />
                <canvas
                  ref={drawCanvasRef}
                  className="absolute inset-0 touch-none"
                  style={{ cursor: tool === 'select' ? 'grab' : tool === 'pen' || tool === 'dashed-pen' ? 'crosshair' : 'cell' }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerUp}
                />
              </div>
            )}

            {pdfDoc && (
              <div className="mt-3 flex items-center gap-2 shrink-0">
                <label className="h-8 inline-flex items-center gap-2 px-3 rounded-lg border text-[13px] font-medium cursor-pointer" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color:'var(--text)' }}>
                  Başka PDF yükle
                  <input type="file" accept="application/pdf" className="hidden" onChange={e => { const input = e.currentTarget; const f = input.files?.[0]; if (f) onFile(f).finally(() => { input.value = '' }); else input.value = '' }} />
                </label>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{fileName}</span>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* Temizle onay modalı */}
      {confirmClearOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={() => setConfirmClearOpen(false)}>
          <div className="w-[320px] rounded-2xl border p-5 shadow-2xl" style={{ background: '#151a23', borderColor: '#232a3b' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}><Trash2 size={16} strokeWidth={2} /></span>
              <div>
                <div className="text-[14px] font-semibold text-white">Sayfa temizlensin mi?</div>
                <div className="text-[12px]" style={{ color: '#8a909e' }}>Bu sayfadaki tüm çizimler ve şekiller silinecek.</div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirmClearOpen(false)} className="h-8 px-3.5 rounded-lg border text-[13px] font-medium transition-colors" style={{ background: 'transparent', borderColor: '#232a3b', color: '#8a909e' }}>Vazgeç</button>
              <button onClick={doClear} className="h-8 px-3.5 rounded-lg border text-[13px] font-semibold text-white" style={{ background: '#ef4444', borderColor: '#ef4444' }}>Temizle</button>
            </div>
          </div>
        </div>
      )}

      <footer className="py-2 text-center text-[11px] border-t shrink-0" style={{ borderColor:'var(--border)', color:'var(--text-muted)', background:'var(--bg-card)' }}>
        B/P Kalem • E Silgi • Ctrl+Z/Y • Delete son çizim • Ctrl+S İndir • Ctrl+0 / +/- • Ctrl+Scroll zoom
      </footer>
    </div>
  )
}
