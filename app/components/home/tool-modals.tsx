'use client';
import { useState } from 'react';
import {
  Archive,
  Award,
  BarChart3,
  Briefcase,
  Check,
  Contact,
  Copy,
  Download,
  Megaphone,
  Printer,
  Wand2,
  Workflow,
} from 'lucide-react';
import { apiPost, apiUpload } from '@/lib/api';
import { ErrorCallout, PrimaryButton, SecondaryButton } from '@/components/ui';
import {
  BusyNote,
  errText,
  FilePick,
  Hint,
  ModalShell,
  PrimaryLink,
  ResultHead,
  SecondaryLink,
  SimpleTable,
  StatChips,
  TextPreview,
} from '@/components/home/modal-shell';

// Модалки-мастера 8 инструментов главной страницы.
// Формы запросов/ответов — один в один с HR Helper/routes/documents.py
// и легаси-скриптами static/js/{characteristic,dpo_report,process_schema,b_tools}.js.

export type ToolKey =
  | 'characteristic'
  | 'certificate'
  | 'vacancy'
  | 'dpo'
  | 'inventory'
  | 'pps'
  | 'process'
  | 'otdedup';

/** Ссылки на созданный документ (view_url/download_url из ответа бэкенда). */
interface DocLinks {
  title: string;
  view_url: string;
  download_url: string;
}

/* ───────────────────────── Б1: Характеристика на награду ───────────────────────── */

const CHR_KEYS = ['award', 'basis', 'fio', 'position', 'department', 'degree', 'rank'] as const;
const CHR_LABELS: Record<(typeof CHR_KEYS)[number], string> = {
  award: 'Награда',
  basis: 'Основание',
  fio: 'ФИО',
  position: 'Должность',
  department: 'Подразделение',
  degree: 'Учёная степень',
  rank: 'Учёное звание',
};

interface ChrAnalyzed {
  fields?: Partial<Record<(typeof CHR_KEYS)[number], string>> & {
    category?: string;
    career?: string[];
    awards?: string[];
    achievements?: string;
  };
}

const INPUT_CLS =
  'w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:border-[#2563eb]';
const LABEL_CLS = 'text-xs font-semibold text-gray-600 space-y-1 block';

function CharacteristicModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'upload' | 'fields' | 'result'>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Поля шага 2 (заполняются анализом ходатайства, правятся вручную)
  const [f, setF] = useState<Record<(typeof CHR_KEYS)[number], string>>({
    award: '', basis: '', fio: '', position: '', department: '', degree: '', rank: '',
  });
  const [category, setCategory] = useState<'pps' | 'aup'>('aup');
  const [career, setCareer] = useState('');
  const [awards, setAwards] = useState('');
  const [achievements, setAchievements] = useState('');

  const [result, setResult] = useState<(DocLinks & { text: string }) | null>(null);

  const analyze = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    try {
      const d = await apiUpload<ChrAnalyzed>('/api/documents/characteristic/analyze', fd);
      const fld = d.fields || {};
      setF({
        award: fld.award || '',
        basis: fld.basis || '',
        fio: fld.fio || '',
        position: fld.position || '',
        department: fld.department || '',
        degree: fld.degree || '',
        rank: fld.rank || '',
      });
      setCategory(fld.category === 'pps' ? 'pps' : 'aup');
      setCareer((fld.career || []).join('\n'));
      setAwards((fld.awards || []).join('\n'));
      setAchievements(fld.achievements || '');
      setStep('fields');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    const fields: Record<string, unknown> = {};
    CHR_KEYS.forEach((k) => {
      fields[k] = f[k].trim() || null;
    });
    fields.career = career;
    fields.awards = awards;
    fields.achievements = achievements.trim() || null;
    if (!fields.fio && !fields.achievements) {
      setError('Заполните хотя бы ФИО или достижения');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const d = await apiPost<DocLinks & { text: string }>('/api/documents/characteristic/generate', {
        fields,
        category,
      });
      setResult(d);
      setStep('result');
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell icon={Award} title="Характеристика для представления к награде" onClose={onClose}>
      {step === 'upload' && (
        <>
          <Hint>
            Загрузите печатную форму «Ходатайство о награждении» из 1С:Документооборот
            (.docx/.doc/.pdf). Файл обрабатывается локально и <b>не сохраняется</b> в базе знаний.
          </Hint>
          <FilePick
            accept=".docx,.doc,.rtf,.pdf,.txt,.odt"
            placeholder="Выбрать файл ходатайства"
            busy={busy}
            onPick={analyze}
          />
          {busy && <BusyNote>Распознаю ходатайство… (извлечение полей ИИ)</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      )}

      {step === 'fields' && (
        <>
          <Hint>Проверьте распознанные поля — при необходимости поправьте, затем сформируйте документ.</Hint>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {CHR_KEYS.map((k) => (
              <label key={k} className={LABEL_CLS}>
                {CHR_LABELS[k]}
                <input
                  value={f[k]}
                  onChange={(e) => setF((cur) => ({ ...cur, [k]: e.target.value }))}
                  className={INPUT_CLS}
                />
              </label>
            ))}
            <label className={LABEL_CLS}>
              Категория
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value === 'pps' ? 'pps' : 'aup')}
                className={INPUT_CLS}
              >
                <option value="pps">ППС (преподаватель)</option>
                <option value="aup">АУП / специалист</option>
              </select>
            </label>
          </div>
          <label className={LABEL_CLS}>
            Трудовая деятельность (по строке на запись)
            <textarea value={career} onChange={(e) => setCareer(e.target.value)} rows={4} className={INPUT_CLS} />
          </label>
          <label className={LABEL_CLS}>
            Награды и поощрения (по строке на запись)
            <textarea value={awards} onChange={(e) => setAwards(e.target.value)} rows={3} className={INPUT_CLS} />
          </label>
          <label className={LABEL_CLS}>
            Конкретные результаты и достижения
            <textarea
              value={achievements}
              onChange={(e) => setAchievements(e.target.value)}
              rows={6}
              className={INPUT_CLS}
            />
          </label>
          {busy && <BusyNote>Формирую характеристику… (обычно 20–60 секунд)</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
          <div className="flex flex-wrap gap-2 pt-1">
            <SecondaryButton onClick={() => { setStep('upload'); setError(''); }} disabled={busy}>
              ← Другой файл
            </SecondaryButton>
            <PrimaryButton onClick={generate} disabled={busy}>
              <Wand2 size={16} /> Сформировать характеристику
            </PrimaryButton>
          </div>
        </>
      )}

      {step === 'result' && result && (
        <>
          <ResultHead>{result.title}</ResultHead>
          <TextPreview text={result.text || ''} />
          <div className="flex flex-wrap gap-2 pt-1">
            <SecondaryLink href={result.view_url}>Просмотреть</SecondaryLink>
            <PrimaryLink href={result.download_url}>Скачать .docx</PrimaryLink>
            <SecondaryButton onClick={() => { setStep('upload'); setError(''); }}>Создать ещё</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Б2: Отчёт по ДПО ───────────────────────── */

interface DpoResult extends DocLinks {
  text: string;
  stats: {
    year: number;
    total_people: number;
    total_programs: number;
    total_records: number;
    long_events: number;
    short_events: number;
  };
}

function DpoModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<DpoResult | null>(null);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    try {
      setResult(await apiUpload<DpoResult>('/api/documents/dpo/report', fd));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell icon={BarChart3} title="Отчёт по ДПО из выгрузки 1С:ЗиК" onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите xlsx-выгрузку «ПК за период» (1С:ЗиК → Обучение). Все цифры отчёта считаются{' '}
            <b>из таблицы</b> — без участия ИИ, ошибки в числах исключены. Файл обрабатывается
            локально и не сохраняется в базе знаний.
          </Hint>
          <FilePick accept=".xlsx,.xlsm" placeholder="Выбрать xlsx-выгрузку" busy={busy} onPick={send} />
          {busy && <BusyNote>Считаю агрегаты и формирую отчёт… (крупная выгрузка — до минуты)</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>{result.title}</ResultHead>
          <StatChips
            items={[
              ['Работников', result.stats.total_people],
              ['Программ', result.stats.total_programs],
              ['Мероприятий ≥16 ч', result.stats.long_events],
              ['Краткосрочных <16 ч', result.stats.short_events],
              ['Всего записей', result.stats.total_records],
            ]}
          />
          <TextPreview text={result.text || ''} />
          <div className="flex flex-wrap gap-2 pt-1">
            <SecondaryLink href={result.view_url}>Просмотреть</SecondaryLink>
            <PrimaryLink href={result.download_url}>Скачать .docx</PrimaryLink>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другой файл</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Б3: Справка на работника ───────────────────────── */

function CertificateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<(DocLinks & { summary: string }) | null>(null);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    try {
      setResult(await apiUpload<DocLinks & { summary: string }>('/api/documents/certificate/convert', fd));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell icon={Contact} title="Справка на работника из 1С:ЗиК" onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите xls-выгрузку «Справка на сотрудника» из 1С:ЗиК. На выходе — аккуратный docx
            для печати: повышение квалификации только за последние 3 года, «Работа по окончании
            ВУЗа» — по должностям (без дублирующих приказов). Без ИИ, файл не сохраняется в базе знаний.
          </Hint>
          <FilePick accept=".xls,.xlsx,.xlsm" placeholder="Выбрать выгрузку (.xls)" busy={busy} onPick={send} />
          {busy && <BusyNote>Преобразую выгрузку в читабельную справку…</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>{result.title}</ResultHead>
          <Hint>{result.summary || ''}</Hint>
          <div className="flex flex-wrap gap-2 pt-1">
            <SecondaryLink href={result.view_url}>Просмотреть</SecondaryLink>
            <PrimaryLink href={result.download_url}>Скачать .docx</PrimaryLink>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другой файл</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Б4: Опись уволенных ───────────────────────── */

interface InvResult {
  title: string;
  download_url: string;
  year: number;
  count: number;
  fired_total: number;
  skipped_rehired: number;
  items: { n: number; fio: string; position: string; unit: string; dismissed_at: string }[];
}

function InventoryModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [allCats, setAllCats] = useState(false);
  const [result, setResult] = useState<InvResult | null>(null);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    fd.append('all_categories', allCats ? 'true' : 'false');
    try {
      setResult(await apiUpload<InvResult>('/api/documents/inventory/build', fd));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell icon={Archive} title="Опись личных дел уволенных" onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите отчёт «Принято уволено» из 1С:ЗиК (Кадры → Отчеты). В опись попадут только
            уволенные <b>без повторного приёма</b> за период; дата увольнения — «дата записи» минус
            1 день. Результат — xlsx по образцу УРП с шапкой и подписями. Без ИИ.
          </Hint>
          <label className="flex items-start gap-2 text-xs font-medium text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={allCats}
              onChange={(e) => setAllCats(e.target.checked)}
              className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              disabled={busy}
            />
            <span>
              Включить все категории персонала (по умолчанию — только АУП, АХП и УВП, как в названии описи)
            </span>
          </label>
          <FilePick accept=".xls,.xlsx,.xlsm" placeholder="Выбрать отчёт (.xls)" busy={busy} onPick={send} />
          {busy && <BusyNote>Ищу уволенных без повторного приёма…</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>{result.title}</ResultHead>
          <StatChips
            items={[
              ['в описи', result.count],
              ['уволено всего', result.fired_total],
              ['повторно приняты (исключены)', result.skipped_rehired],
              ['год', result.year],
            ]}
          />
          {result.items.length ? (
            <SimpleTable
              head={['№', 'Ф.И.О.', 'Должность', 'Подразделение', 'Дата увольнения']}
              rows={result.items.slice(0, 50).map((it) => ({
                cells: [it.n, it.fio, it.position, it.unit, it.dismissed_at],
              }))}
            />
          ) : (
            <Hint>Под условия описи никто не попал.</Hint>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <PrimaryLink href={result.download_url}>Скачать опись .xlsx</PrimaryLink>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другой файл</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Б5: Объявление конкурса ППС ───────────────────────── */

interface PpsResult extends DocLinks {
  date: string;
  positions: number;
  departments: number;
  people: number;
  sections: { header: string; count: number }[];
}

function PpsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PpsResult | null>(null);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f)); // несколько файлов под одним именем
    try {
      setResult(await apiUpload<PpsResult>('/api/documents/pps/announcement', fd));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell icon={Megaphone} title="Объявление о выборах и конкурсе ППС" onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите выгрузки «Форма 2» из 1С:ЗиК (Кадры → Аттестации → Конкурсные отборы и выборы
            → печать → форма 2) — <b>можно несколько файлов сразу</b>, по одному на должность.
            Требования в скобках собираются из данных переизбираемых работников (специальность,
            учёная степень) — это черновик, отредактируйте его в Word. Без ИИ.
          </Hint>
          <FilePick
            accept=".xls,.xlsx,.xlsm"
            multiple
            placeholder="Выбрать файлы «Форма 2»"
            busy={busy}
            onPick={send}
          />
          {busy && <BusyNote>Собираю объявление по должностям и кафедрам…</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>{result.title}</ResultHead>
          <StatChips
            items={[
              ['должностей', result.positions],
              ['кафедр', result.departments],
              ['работников в выгрузках', result.people],
            ]}
          />
          {result.sections.length > 0 && (
            <StatChips items={result.sections.map((s) => [s.header, s.count] as [string, React.ReactNode])} />
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <SecondaryLink href={result.view_url}>Просмотреть</SecondaryLink>
            <PrimaryLink href={result.download_url}>Скачать .docx</PrimaryLink>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другие файлы</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Б6: Вакансия из инструкции ───────────────────────── */

interface VacResult extends DocLinks {
  text: string;
  position?: string | null;
  section_found?: boolean;
}

function VacancyModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VacResult | null>(null);
  const [copied, setCopied] = useState(false);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    try {
      setResult(await apiUpload<VacResult>('/api/documents/vacancy/generate', fd));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* буфер обмена недоступен */
    }
  };

  return (
    <ModalShell icon={Briefcase} title="Текст вакансии из должностной инструкции" onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите должностную инструкцию (.docx/.doc/.pdf). ИИ перепишет раздел 2 «Должностные
            обязанности» в удобную форму для hh.ru: обязанности, требования, условия. Зарплату и
            график НЕ выдумывает — их добавляет специалист УРП. Файл не сохраняется в базе знаний.
          </Hint>
          <FilePick
            accept=".docx,.doc,.rtf,.pdf,.txt,.odt"
            placeholder="Выбрать должностную инструкцию"
            busy={busy}
            onPick={send}
          />
          {busy && <BusyNote>Читаю инструкцию и пишу текст вакансии… (обычно до минуты)</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>
            {result.title}
            {result.section_found ? '' : ' (раздел 2 не найден — использован весь текст)'}
          </ResultHead>
          <textarea
            readOnly
            value={result.text || ''}
            rows={12}
            className="w-full px-3 py-2 bg-gray-50 border border-gray-100 rounded-xl text-xs text-slate-700 leading-relaxed focus:outline-none resize-y"
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <SecondaryButton onClick={copy}>
              {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
              {copied ? 'Скопировано' : 'Копировать текст'}
            </SecondaryButton>
            <SecondaryLink href={result.view_url}>Просмотреть</SecondaryLink>
            <PrimaryLink href={result.download_url}>Скачать .docx</PrimaryLink>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другой файл</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Б7: Дубликаты инструкций ОТ ───────────────────────── */

interface OtdResult {
  download_url: string;
  files: number;
  duplicates: number;
  unreadable: string[];
  pairs: { a: string; b: string; percent: number }[];
  groups: { size: number; min_percent: number; max_percent: number; files: string[] }[];
}

function OtDedupModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<OtdResult | null>(null);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    try {
      setResult(await apiUpload<OtdResult>('/api/documents/ot/dedup', fd));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell icon={Copy} title="Поиск однотипных инструкций по охране труда" wide onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите <b>архив ZIP или 7z</b> с инструкциями (docx/doc/pdf/rtf/txt, до 500 файлов).
            Совпадение считается по тексту детерминированно, без ИИ. Пары с совпадением <b>≥80%</b> —
            кандидаты на объединение; они группируются в семейства однотипных. Старые .doc
            обрабатываются заметно дольше — при возможности используйте docx.
          </Hint>
          <FilePick accept=".zip,.7z" placeholder="Выбрать архив (ZIP или 7z)" busy={busy} onPick={send} />
          {busy && <BusyNote>Разбираю архив и сравниваю тексты… (сотни файлов — несколько минут)</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>
            Проверено файлов: {result.files}, пар-дубликатов (≥80%): {result.duplicates}
          </ResultHead>
          <StatChips
            items={[
              ['файлов', result.files],
              ['пар ≥80%', result.duplicates],
              ['пар 60–80%', result.pairs.length - result.duplicates],
              ['групп однотипных', result.groups.length],
            ]}
          />
          {result.groups.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-bold text-[#0f1c3f]">Группы однотипных (кандидаты на объединение)</h4>
              {result.groups.map((g, i) => (
                <div key={i} className="bg-gray-50 border border-gray-100 rounded-xl p-3 text-xs text-slate-600">
                  <p className="font-semibold text-[#0f1c3f]">
                    {g.size} файлов · совпадение{' '}
                    {g.min_percent === g.max_percent ? g.max_percent : `${g.min_percent}–${g.max_percent}`}%
                  </p>
                  {g.files.map((name, j) => (
                    <p key={j} className="truncate" title={name}>
                      {name}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
          {result.pairs.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-bold text-[#0f1c3f]">Пары (топ-30)</h4>
              <SimpleTable
                head={['Инструкция 1', 'Инструкция 2', '%']}
                rows={result.pairs.slice(0, 30).map((p) => ({
                  cells: [p.a, p.b, p.percent],
                  highlight: p.percent >= 80,
                }))}
              />
            </div>
          )}
          {!result.groups.length && !result.pairs.length && (
            <Hint>Совпадений выше 60% не найдено — дубликатов нет.</Hint>
          )}
          {result.unreadable.length > 0 && (
            <p className="text-xs font-medium text-amber-600 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              Не удалось прочитать: {result.unreadable.join(', ')}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <PrimaryLink href={result.download_url}>Скачать отчёт .xlsx</PrimaryLink>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другой архив</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── А10: Единая схема процесса ───────────────────────── */

interface PrcResult {
  title: string | null;
  svg: string;
  nodes: number;
  edges: number;
  roles: number;
}

function ProcessModal({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PrcResult | null>(null);

  const send = async (files: File[]) => {
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('file', files[0]);
    try {
      setResult(await apiUpload<PrcResult>('/api/documents/process/render', fd));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // Скачивание SVG через Blob (эндпоинт файл не сохраняет)
  const downloadSvg = () => {
    if (!result?.svg) return;
    const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.title || 'схема'}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Печать: отдельное окно только со схемой (масштабируется на страницу)
  const printSvg = () => {
    if (!result?.svg) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      '<!doctype html><title>' +
        String(result.title || 'схема').replace(/</g, '&lt;') +
        '</title><style>body{margin:0;padding:16px}svg{max-width:100%;height:auto}</style>' +
        result.svg
    );
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <ModalShell icon={Workflow} title="Схема процесса в едином стиле ТИУ" wide onClose={onClose}>
      {!result ? (
        <>
          <Hint>
            Загрузите файл со схемой процесса — Word (.docx/.doc), Excel (.xlsx/.xls) или PowerPoint
            (.pptx/.ppt). Блоки, стрелки, роли подразделений и условия переходов будут распознаны и
            перерисованы в едином стиле. Схемы-картинки (сканы) преобразовать нельзя. Файл
            обрабатывается локально и не сохраняется.
          </Hint>
          <FilePick
            accept=".docx,.doc,.pptx,.ppt,.xlsx,.xlsm,.xls"
            placeholder="Выбрать файл со схемой"
            busy={busy}
            onPick={send}
          />
          {busy && <BusyNote>Распознаю блоки и стрелки, рисую схему…</BusyNote>}
          {error && <ErrorCallout>{error}</ErrorCallout>}
        </>
      ) : (
        <>
          <ResultHead>{result.title || 'Схема процесса'}</ResultHead>
          <StatChips
            items={[
              ['Блоков', result.nodes],
              ['Переходов', result.edges],
              ['Ролей', result.roles],
            ]}
          />
          {/* SVG приходит строкой из бэкенда (детерминированный рендер) — вставляем инлайн */}
          <div
            className="border border-gray-100 rounded-xl bg-white p-3 overflow-auto max-h-[50vh]"
            dangerouslySetInnerHTML={{ __html: result.svg }}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <PrimaryButton onClick={downloadSvg}>
              <Download size={16} /> Скачать SVG
            </PrimaryButton>
            <SecondaryButton onClick={printSvg}>
              <Printer size={16} /> Печать
            </SecondaryButton>
            <SecondaryButton onClick={() => { setResult(null); setError(''); }}>Другой файл</SecondaryButton>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ───────────────────────── Диспетчер модалок ───────────────────────── */

/** Рендерит модалку выбранного инструмента. onDocsChanged — обновить «Мои документы». */
export function ToolModal({
  tool,
  onClose,
  onDocsChanged,
}: {
  tool: ToolKey;
  onClose: () => void;
  onDocsChanged: () => void;
}) {
  switch (tool) {
    case 'characteristic':
      return <CharacteristicModal onClose={onClose} onDone={onDocsChanged} />;
    case 'certificate':
      return <CertificateModal onClose={onClose} onDone={onDocsChanged} />;
    case 'vacancy':
      return <VacancyModal onClose={onClose} onDone={onDocsChanged} />;
    case 'dpo':
      return <DpoModal onClose={onClose} onDone={onDocsChanged} />;
    case 'inventory':
      return <InventoryModal onClose={onClose} onDone={onDocsChanged} />;
    case 'pps':
      return <PpsModal onClose={onClose} onDone={onDocsChanged} />;
    case 'otdedup':
      return <OtDedupModal onClose={onClose} onDone={onDocsChanged} />;
    case 'process':
      return <ProcessModal onClose={onClose} />;
  }
}
