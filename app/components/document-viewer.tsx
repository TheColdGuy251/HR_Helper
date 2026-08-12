'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileQuestion,
  FileWarning,
  Lock,
  Pencil,
  X,
} from 'lucide-react';
import { apiGet, apiPatch, ApiError } from '@/lib/api';
import { InfoCallout } from '@/components/ui';

// Универсальный просмотрщик документов — порт templates/document_view.html.
// Контекст берётся из app/api/view/* (те же поля, что отдавал FastAPI при
// ?format=json). Отдельный адрес нужен потому, что путь самой страницы
// (/kb/documents/[id]/view и т.п.) уже занят Next-страницей.

type ViewMode =
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'docx'
  | 'xlsx'
  | 'diff'
  | 'ocr_split'
  | 'missing'
  | 'forbidden'
  | 'unsupported';

interface ViewCtx {
  title: string;
  mode: ViewMode;
  download_url: string;
  content?: string;
  content_html?: string;
  inline_url?: string;
  text_note?: string;
  original_url?: string;
  text_url?: string;
  source_url?: string;
  kb_doc_id?: number;
  can_edit?: boolean;
  original_pdf?: boolean;
  original_image?: boolean;
}

// Глобальные стили просмотрщика: оформление markdown-HTML (Tailwind preflight
// сбрасывает всё), diff-классы (совпадают с легаси), docx-preview и таблицы xlsx.
const VIEWER_CSS = `
.dv-md h1,.dv-md h2,.dv-md h3,.dv-md h4,.dv-md h5,.dv-md h6{color:#0f1c3f;line-height:1.3;margin:1.3em 0 .5em;font-weight:700}
.dv-md :first-child{margin-top:0}
.dv-md h1{font-size:1.9em}.dv-md h2{font-size:1.5em}.dv-md h3{font-size:1.25em}.dv-md h4{font-size:1.1em}
.dv-md p{margin:.7em 0}
.dv-md ul,.dv-md ol{margin:.7em 0;padding-left:1.6em}
.dv-md ul{list-style:disc}.dv-md ol{list-style:decimal}
.dv-md li{margin:.25em 0}
.dv-md a{color:#2563eb;text-decoration:underline}
.dv-md img{max-width:100%;height:auto}
.dv-md hr{border:none;border-top:1px solid #e5e7eb;margin:1.4em 0}
.dv-md blockquote{margin:1em 0;padding:.4em 1.1em;color:#64748b;border-left:3px solid #e5e7eb}
.dv-md code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:.92em}
.dv-md pre{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;overflow:auto}
.dv-md pre code{background:none;padding:0}
.dv-md table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.95em}
.dv-md th,.dv-md td{border:1px solid #e5e7eb;padding:7px 10px;text-align:left;vertical-align:top}
.dv-md th{background:#f8fafc;font-weight:700}
/* Diff (классы как в легаси document_view.html) */
.dvd-line{white-space:pre-wrap;word-break:break-word;min-height:1.2em;padding:1px 6px;border-radius:3px}
.dvd-add{background:#fef2f2;color:#b91c1c}
.dvd-del{background:#f8fafc;color:#94a3b8;text-decoration:line-through}
/* docx-preview: фон-обёртка + «листы»; битые EMF/WMF-картинки прячем */
.docx-wrapper{background:#f4f7fc;padding:32px 16px 48px}
.docx-wrapper>section.docx{background:#fff;box-shadow:0 4px 24px rgba(15,23,42,.12);margin-bottom:28px}
.docx-wrapper img[src^="data:image/x-emf"],.docx-wrapper img[src^="data:image/x-wmf"]{display:none}
@media (max-width:768px){
  .docx-wrapper{align-items:flex-start!important;overflow-x:auto;padding:16px 8px 32px;-webkit-overflow-scrolling:touch}
  .docx-wrapper>section.docx{margin-left:0;margin-right:0}
}
/* Excel (SheetJS sheet_to_html) */
.dv-sheet table{border-collapse:collapse;font-size:13px;width:max-content}
.dv-sheet td,.dv-sheet th{border:1px solid #e5e7eb;padding:5px 10px;white-space:nowrap;min-width:56px;max-width:480px;overflow:hidden;text-overflow:ellipsis}
.dv-sheet tr:first-child td{background:#f9fafb;font-weight:600}
`;

// Страница-обёртка → эндпоинт контекста. Пять пар, ровно как пять view-роутов
// в backend/routes/pages.py; basePath приходит из app/**/view/page.tsx.
const VIEW_ENDPOINTS: Record<string, string> = {
  'kb/documents': 'kb-document',
  'kb/templates': 'kb-template',
  documents: 'document',
  'messenger/files': 'messenger-file',
  'news/media': 'news-media',
};

function viewEndpoint(basePath: string): string | null {
  const m = /^\/(.+)\/([^/]+)\/view$/.exec(basePath);
  if (!m) return null;
  const kind = VIEW_ENDPOINTS[m[1]];
  return kind ? `/api/view/${kind}/${encodeURIComponent(m[2])}` : null;
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="max-w-md mx-auto my-24 text-center text-sm text-gray-500">
      <div className="w-9 h-9 mx-auto mb-4 rounded-full border-[3px] border-gray-200 border-t-[#2563eb] animate-spin" />
      {label}
    </div>
  );
}

/** Пустое/ошибочное состояние по центру экрана. */
function StateBox({
  icon: Icon,
  children,
}: {
  icon?: typeof FileQuestion;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-md mx-auto my-24 px-6 text-center text-sm text-gray-500 flex flex-col items-center gap-4">
      {Icon && (
        <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-400">
          <Icon size={26} />
        </div>
      )}
      {children}
    </div>
  );
}

/** Кнопка-ссылка «Скачать файл» для empty-состояний. */
function DownloadLink({ href, label = 'Скачать файл' }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 bg-[#2563eb] text-white px-5 py-3 rounded-xl font-semibold text-sm hover:bg-[#1e40af] transition shadow-md shadow-blue-100"
    >
      <Download size={16} /> {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Модалка правки извлечённого текста (kb-документы, can_edit)
// ---------------------------------------------------------------------------

function EditModal({ docId, onClose }: { docId: number; onClose: () => void }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiGet<{ content?: string }>(`/api/kb/documents/${docId}/content`)
      .then((d) => {
        if (cancelled) return;
        setText(d.content || '');
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof ApiError ? e.message : 'Не удалось загрузить текст');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (loading || loadError || saving || saved) return;
    if (!confirm('Сохранить текст и переиндексировать документ? Поиск по нему будет недоступен ~минуту.')) return;
    setSaving(true);
    setSaveError('');
    try {
      await apiPatch(`/api/kb/documents/${docId}/content`, { content: text });
      setSaved(true);
      // Даём прочитать сообщение об успехе и уходим в базу знаний
      setTimeout(() => {
        window.location.href = '/kb';
      }, 1400);
    } catch (e: unknown) {
      setSaveError(e instanceof ApiError ? e.message : 'Не удалось сохранить');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/55 flex items-center justify-center p-[3vh_3vw]">
      <div className="bg-white rounded-2xl w-full max-w-[1000px] h-[88vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-gray-200 relative">
          <b className="text-[#0f1c3f]">Правка извлечённого текста</b>
          <p className="mt-1 text-xs text-gray-500 pr-8">
            Исходный файл не меняется — правится текст, по которому ищет и отвечает бот. После
            сохранения документ будет переиндексирован (чанки, эмбеддинги, ссылки).
          </p>
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 text-gray-400 hover:text-slate-700 transition"
            title="Закрыть"
          >
            <X size={22} />
          </button>
        </div>

        {loadError ? (
          <div className="flex-1 p-5 text-sm text-red-600">{loadError}</div>
        ) : (
          <textarea
            value={loading ? 'Загрузка…' : text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading || saving || saved}
            spellCheck={false}
            className="flex-1 resize-none outline-none border-none p-4 font-mono text-[13px] leading-relaxed text-slate-800"
          />
        )}

        <div className="flex items-center gap-2.5 px-5 py-3 border-t border-gray-200 bg-gray-50">
          <span className="mr-auto text-xs text-gray-500">
            {saved ? (
              <span className="text-emerald-600 font-semibold">
                Сохранено, документ переиндексируется
              </span>
            ) : saveError ? (
              <span className="text-red-600 font-semibold">{saveError}</span>
            ) : loading ? (
              ''
            ) : (
              `${text.length.toLocaleString('ru-RU')} символов`
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="border border-gray-200 bg-white text-gray-500 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-100 transition"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={save}
            disabled={loading || !!loadError || saving || saved}
            className="bg-[#2563eb] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#1e40af] transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saved ? 'Сохранено ✓' : saving ? 'Сохраняю…' : 'Сохранить и переиндексировать'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Основной компонент
// ---------------------------------------------------------------------------

export default function DocumentViewer({ basePath }: { basePath: string }) {
  const [ctx, setCtx] = useState<ViewCtx | null>(null);
  const [fetchError, setFetchError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [editOpen, setEditOpen] = useState(false);

  // docx-рендер
  const docxRootRef = useRef<HTMLDivElement | null>(null);
  const [docxState, setDocxState] = useState<'loading' | 'done' | 'failed'>('loading');
  const [docxError, setDocxError] = useState('');

  // xlsx-рендер
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [xlsxError, setXlsxError] = useState('');

  // 1. Загрузка JSON-контекста просмотра (эндпоинт выводится из basePath)
  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    setFetchError('');
    (async () => {
      try {
        const endpoint = viewEndpoint(basePath);
        if (!endpoint) throw new Error('Неизвестный тип документа');
        // ?text=1 / ?original=1 / ?diff=N со страницы уходят в API как есть.
        const params = new URLSearchParams(window.location.search).toString();
        const res = await fetch(params ? `${endpoint}?${params}` : endpoint, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        // Неавторизован: API отдаёт 401 JSON, на логин уводим сами.
        const isJson = (res.headers.get('content-type') || '').includes('application/json');
        if (res.status === 401 || !isJson) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        if (!res.ok) throw new Error(`Ошибка сервера (${res.status})`);
        const data = (await res.json()) as ViewCtx;
        if (cancelled) return;
        if (data.mode === 'pdf') {
          // Нативный просмотрщик PDF браузера — без обёртки приложения
          window.location.replace(data.inline_url || data.download_url);
        }
        setCtx(data);
      } catch (e: unknown) {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : 'Ошибка сети');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [basePath, attempt]);

  // 2. Рендер docx через docx-preview (с вотчдогом 20 с, как в легаси)
  useEffect(() => {
    if (!ctx || ctx.mode !== 'docx' || !ctx.inline_url) return;
    const root = docxRootRef.current;
    if (!root) return;
    let cancelled = false;
    let finished = false;
    setDocxState('loading');
    setDocxError('');
    // Вотчдог: сложный документ может рендериться бесконечно — через 20 с
    // предлагаем текстовую версию. Успешное завершение позже снимает фолбэк.
    const watchdog = setTimeout(() => {
      if (!finished && !cancelled) {
        setDocxError(
          'Документ большой или содержит элементы, которые браузер не может отобразить — отрисовка затянулась.'
        );
        setDocxState('failed');
      }
    }, 20000);
    (async () => {
      const res = await fetch(ctx.inline_url!, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const { renderAsync } = await import('docx-preview');
      if (cancelled) return;
      root.innerHTML = '';
      await renderAsync(blob, root, undefined, {
        className: 'docx',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        experimental: true,
        renderHeaders: true,
        renderFooters: true,
      });
      finished = true;
      if (cancelled) return;
      // EMF/WMF браузер не отображает — прячем битые картинки, чтобы не
      // оставались огромные пустые области (data-EMF скрыт ещё и через CSS).
      root.querySelectorAll('img').forEach((img) => {
        const drop = () => {
          img.style.display = 'none';
        };
        if (img.complete && img.naturalWidth === 0) drop();
        else img.addEventListener('error', drop);
      });
      setDocxState('done');
    })()
      .catch((e: unknown) => {
        finished = true;
        if (!cancelled) {
          setDocxError(
            `Не удалось отобразить документ (${e instanceof Error ? e.message : 'ошибка'}).`
          );
          setDocxState('failed');
        }
      })
      .finally(() => clearTimeout(watchdog));
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, [ctx]);

  // 3. Рендер xlsx через SheetJS: вкладки по листам
  useEffect(() => {
    if (!ctx || ctx.mode !== 'xlsx' || !ctx.inline_url) return;
    let cancelled = false;
    setSheets(null);
    setActiveSheet(0);
    setXlsxError('');
    (async () => {
      const res = await fetch(ctx.inline_url!, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.arrayBuffer();
      const XLSX = await import('xlsx');
      if (cancelled) return;
      const wb = XLSX.read(buf, { type: 'array' });
      setSheets(
        wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false }),
        }))
      );
    })().catch((e: unknown) => {
      if (!cancelled)
        setXlsxError(
          `Не удалось отобразить таблицу (${e instanceof Error ? e.message : 'ошибка'}).`
        );
    });
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  // ------------------------------------------------------------------ тело
  let body: React.ReactNode;
  if (fetchError) {
    body = (
      <StateBox icon={FileWarning}>
        <span>Не удалось загрузить документ: {fetchError}</span>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="border border-gray-200 bg-white text-slate-600 px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-50 transition"
        >
          Повторить
        </button>
      </StateBox>
    );
  } else if (!ctx) {
    body = <Spinner label="Загрузка документа…" />;
  } else {
    switch (ctx.mode) {
      case 'pdf':
        body = <Spinner label="Открываю PDF…" />;
        break;

      case 'missing':
        body = <StateBox icon={FileQuestion}>Документ не найден.</StateBox>;
        break;

      case 'forbidden':
        body = <StateBox icon={Lock}>Доступ к файлу запрещён.</StateBox>;
        break;

      case 'unsupported':
        body = (
          <StateBox icon={FileWarning}>
            <span>Предпросмотр для этого типа файла недоступен.</span>
            <DownloadLink href={ctx.download_url} />
          </StateBox>
        );
        break;

      case 'markdown':
      case 'diff':
        body = (
          <div className="max-w-[850px] w-full mx-auto px-2 sm:px-0 my-4 sm:my-8 flex flex-col gap-3">
            {ctx.source_url && (
              <a
                href={ctx.source_url}
                target="_blank"
                rel="noreferrer"
                className="self-end inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563eb] hover:underline"
              >
                <ExternalLink size={14} /> Оригинал
              </a>
            )}
            <article className="bg-white border border-gray-100 rounded-2xl shadow-sm px-4 py-5 sm:px-16 sm:py-14">
              {ctx.mode === 'diff' && (
                <div className="text-[13px] text-gray-500 mb-3.5 pb-2.5 border-b border-gray-200">
                  Обновление веб-страницы:{' '}
                  <span className="dvd-add">красным — новый/изменённый текст</span>,{' '}
                  <span className="dvd-del">зачёркнутым — удалённый</span>.
                </div>
              )}
              <div
                className="dv-md text-[15px] leading-relaxed text-slate-800"
                dangerouslySetInnerHTML={{ __html: ctx.content_html || '' }}
              />
            </article>
          </div>
        );
        break;

      case 'text':
        body = (
          <div className="max-w-[850px] w-full mx-auto px-2 sm:px-0 my-4 sm:my-8 flex flex-col gap-4">
            {ctx.text_note && (
              <InfoCallout>
                <span className="font-semibold">{ctx.text_note}</span>
                {ctx.original_url && (
                  <a href={ctx.original_url} className="underline ml-2 whitespace-nowrap">
                    Показать оригинальное форматирование
                  </a>
                )}
                <a href={ctx.download_url} className="underline ml-2 whitespace-nowrap">
                  Скачать оригинал
                </a>
              </InfoCallout>
            )}
            <article className="bg-white border border-gray-100 rounded-2xl shadow-sm px-4 py-5 sm:px-16 sm:py-14">
              <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-slate-800 m-0">
                {ctx.content}
              </pre>
            </article>
          </div>
        );
        break;

      case 'docx':
        body = (
          <div>
            {docxState === 'loading' && <Spinner label="Загрузка документа…" />}
            {docxState === 'failed' && (
              <StateBox icon={FileWarning}>
                <span>{docxError}</span>
                {(ctx.content || '').trim() && (
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm text-left text-slate-700 bg-white border border-gray-100 rounded-2xl shadow-sm p-5 max-h-[50vh] overflow-auto w-full">
                    {ctx.content}
                  </pre>
                )}
                {ctx.text_url ? (
                  <a href={ctx.text_url} className="text-[#2563eb] font-semibold hover:underline">
                    Открыть текстовую версию
                  </a>
                ) : (
                  <DownloadLink href={ctx.download_url} />
                )}
              </StateBox>
            )}
            {/* Контейнер рендера остаётся в DOM: если вотчдог сработал, а рендер
                всё же завершился — состояние станет done и документ появится */}
            <div ref={docxRootRef} className={docxState === 'failed' ? 'hidden' : ''} />
          </div>
        );
        break;

      case 'xlsx':
        body = xlsxError ? (
          <StateBox icon={FileWarning}>
            <span>{xlsxError}</span>
            <DownloadLink href={ctx.download_url} />
          </StateBox>
        ) : !sheets ? (
          <Spinner label="Загрузка таблицы…" />
        ) : sheets.length === 0 ? (
          <StateBox icon={FileQuestion}>Книга пуста.</StateBox>
        ) : (
          <div className="mx-3 sm:mx-6 my-5">
            <div className="flex flex-wrap gap-1">
              {sheets.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveSheet(i)}
                  className={`px-4 py-2 rounded-t-lg border border-b-0 text-[13px] font-semibold transition ${
                    i === activeSheet
                      ? 'bg-white text-[#0f1c3f] border-gray-200'
                      : 'bg-gray-200 text-gray-500 border-gray-200 hover:text-slate-700'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div className="dv-sheet bg-white border border-gray-200 rounded-b-xl rounded-tr-xl overflow-auto max-h-[calc(100vh-190px)] shadow-sm">
              <div dangerouslySetInnerHTML={{ __html: sheets[activeSheet]?.html || '' }} />
            </div>
          </div>
        );
        break;

      case 'ocr_split':
        body = (
          <div
            className="mx-3 sm:mx-6 my-4 flex flex-col gap-3"
            style={{ minHeight: 'calc(100vh - 160px)' }}
          >
            <InfoCallout>
              <b>Документ распознан через OCR.</b> Слева — оригинал, справа — извлечённый текст.
              Сверьте распознанное с оригиналом.
            </InfoCallout>
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
              <div className="h-[70vh] md:h-auto bg-[#525659] md:border-r border-gray-200 overflow-auto">
                {ctx.original_pdf && ctx.inline_url ? (
                  <iframe src={ctx.inline_url} title="Оригинал" className="w-full h-full border-0 block" />
                ) : ctx.original_image && ctx.inline_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ctx.inline_url} alt="Оригинал" className="w-full h-auto block" />
                ) : (
                  <div className="p-10 text-center">
                    <a href={ctx.download_url} className="text-blue-200 underline text-sm">
                      Скачать оригинал
                    </a>
                  </div>
                )}
              </div>
              <div className="h-[70vh] md:h-auto overflow-auto bg-white">
                <div className="sticky top-0 bg-gray-50 border-b border-gray-200 px-5 py-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Извлечённый текст
                </div>
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-800 px-5 py-4 m-0">
                  {ctx.content}
                </pre>
              </div>
            </div>
          </div>
        );
        break;

      default:
        body = (
          <StateBox icon={FileWarning}>
            <span>Предпросмотр недоступен.</span>
            <DownloadLink href={ctx.download_url} />
          </StateBox>
        );
    }
  }

  const showPill = !!ctx && ctx.mode !== 'pdf';
  const showDownload = !!ctx && !['missing', 'forbidden'].includes(ctx.mode);
  const showEdit = !!ctx && !!ctx.can_edit && ctx.kb_doc_id != null;

  return (
    <div className="flex-1 w-full pb-10">
      <style>{VIEWER_CSS}</style>

      {/* Плавающая «пилюля»: название + скачать + править текст */}
      {showPill && (
        <div className="sticky top-3 z-40 flex justify-center px-4 pt-3">
          <div className="flex items-center gap-2.5 bg-white/95 backdrop-blur border border-gray-100 shadow-md rounded-full pl-5 pr-2 py-1.5 max-w-full">
            <span
              className="text-sm font-bold text-[#0f1c3f] truncate max-w-[38vw] sm:max-w-md"
              title={ctx!.title}
            >
              {ctx!.title}
            </span>
            {showDownload && (
              <a
                href={ctx!.download_url}
                title="Скачать документ"
                className="inline-flex items-center gap-1.5 bg-[#2563eb] text-white px-4 py-2 rounded-full text-[13px] font-semibold hover:bg-[#1e40af] transition shrink-0"
              >
                <Download size={14} /> <span className="hidden sm:inline">Скачать</span>
              </a>
            )}
            {showEdit && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                title="Править извлечённый текст (бот отвечает по нему)"
                className="inline-flex items-center gap-1.5 bg-teal-700 text-white px-4 py-2 rounded-full text-[13px] font-semibold hover:bg-teal-800 transition shrink-0"
              >
                <Pencil size={14} /> <span className="hidden sm:inline">Править текст</span>
              </button>
            )}
          </div>
        </div>
      )}

      {body}

      {editOpen && showEdit && (
        <EditModal docId={ctx!.kb_doc_id!} onClose={() => setEditOpen(false)} />
      )}
    </div>
  );
}
