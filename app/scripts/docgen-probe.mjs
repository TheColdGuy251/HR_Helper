// Проверка слоя "инструменты и генерация документов внутри диалога".
//
// Гоняет реальные фразы через runGeneration (тот же код, что обслуживает
// POST /api/chat/stream) и печатает, что получил пользователь: текст ответа и
// прикреплённый документ (карточка "Скачать"), либо обычный RAG-ответ.
//
// Использование:
//   node scripts/docgen-probe.mjs            - все сценарии
//   node scripts/docgen-probe.mjs 1 3        - только сценарии №1 и №3
//   node scripts/docgen-probe.mjs --keep     - не удалять созданные записи
//
// Нужны поднятый PostgreSQL и локальная LLM (без неё detectTemplate/extractFields
// вернут пустоту, и всё честно уйдёт в RAG - это тоже видно в выводе).
// Модули lib/** - TypeScript с алиасом "@/", поэтому грузим их через jiti.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import * as XLSX from 'xlsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': ROOT,
    'server-only': path.join(ROOT, 'node_modules/next/dist/compiled/server-only/empty.js'),
  },
});
const load = (rel) => jiti.import(path.join(ROOT, rel));

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const ONLY = new Set(args.filter((a) => /^\d+$/.test(a)).map(Number));

// Порядок важен: сначала поднимаем llama.cpp, и только потом всё остальное.
// Если первым на видеокарту зайдёт эмбеддер (onnxruntime через resolveIntent),
// последующая загрузка модели падает с "CUDA error" - они не уживаются на одной
// карте. В Next то же самое обеспечивает прогрев на старте процесса.
const { isLlmAvailable } = await load('lib/ml/llm.ts');
const llmReady = await isLlmAvailable();
console.log(`LLM доступна: ${llmReady ? 'да' : 'нет (детект шаблона и извлечение полей вернут пустоту)'}`);

const [{ prisma }, { StreamState, registerStream, unregisterStream }, { runGeneration }, docgen] =
  await Promise.all([
    load('lib/db.ts'),
    load('lib/chat.ts'),
    load('lib/chat-generate.ts'),
    load('lib/docs/docgen.ts'),
  ]);

// подготовка временного диалога

const user = await prisma.users.findFirst({ orderBy: { id: 'asc' } });
if (!user) {
  console.error('В базе нет пользователей — сценарии запускать не на ком.');
  process.exit(1);
}

const dialogue = await prisma.dialogues.create({
  data: {
    user_id: user.id,
    title: '[probe] докген в диалоге',
    is_finished: false,
  },
});

const created = { docIds: [], files: [] };

async function ask(label, text, attachments = []) {
  const userMsg = await prisma.chat_messages.create({
    data: {
      dialogue_id: dialogue.id,
      role: 'user',
      content: text,
      is_read: true,
      is_finished: true,
      is_cancelled: false,
      last_seq: 0,
      variant_active: true,
    },
  });
  const asstMsg = await prisma.chat_messages.create({
    data: {
      dialogue_id: dialogue.id,
      role: 'assistant',
      content: '',
      is_read: false,
      is_finished: false,
      is_cancelled: false,
      last_seq: 0,
      variant_active: true,
      reply_to: userMsg.id,
    },
  });

  const attached = [];
  for (const att of attachments) {
    const rec = await prisma.chat_attachments.create({
      data: {
        dialogue_id: dialogue.id,
        message_id: userMsg.id,
        filename: att.filename,
        mime_type: att.mime || null,
        size_bytes: fs.statSync(att.storedPath).size,
        stored_path: att.storedPath,
        content: att.content,
      },
    });
    attached.push({
      id: rec.id,
      filename: rec.filename,
      content: rec.content,
      stored_path: rec.stored_path,
    });
  }

  const state = new StreamState(dialogue.id, asstMsg.id, userMsg.id);
  registerStream(state);
  const stages = [];
  const origSetStatus = state.setStatus.bind(state);
  state.setStatus = (s) => {
    stages.push(s);
    origSetStatus(s);
  };

  const t0 = Date.now();
  await runGeneration({
    userText: text,
    assistantMessageId: asstMsg.id,
    dialogueId: dialogue.id,
    userId: user.id,
    useRag: true,
    history: [],
    attachedDocuments: attached,
    dialogueSummary: null,
    state,
    forwarded: false,
    faqId: null,
  });
  unregisterStream(state);

  const saved = await prisma.chat_messages.findUnique({ where: { id: asstMsg.id } });
  const doc = saved?.attachment_document_id
    ? await prisma.my_documents.findUnique({
        where: { id: saved.attachment_document_id },
        include: { template: { select: { key: true } } },
      })
    : null;
  if (doc) {
    created.docIds.push(doc.id);
    if (doc.file_path) created.files.push(doc.file_path);
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`▶ ${label}`);
  console.log(`  запрос: «${text}»${attachments.length ? ` + вложение ${attachments[0].filename}` : ''}`);
  console.log(`  стадии: ${stages.join(' → ') || '—'}   (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
  console.log(`${'─'.repeat(78)}`);
  console.log((saved?.content || '(пусто)').trim());
  console.log(`${'─'.repeat(78)}`);
  if (doc) {
    console.log('  ✅ ДОКУМЕНТ ПРИКРЕПЛЁН К ОТВЕТУ (в UI — карточка «Скачать»)');
    console.log(`     document_id : ${doc.id}`);
    console.log(`     title       : ${doc.title}`);
    console.log(`     template_key: ${doc.generator === 'template' ? doc.template?.key : doc.generator}`);
    console.log(`     file        : ${doc.file_path}`);
    console.log(`     файл на диске: ${doc.file_path && fs.existsSync(doc.file_path) ? 'есть' : 'НЕТ'}`);
    console.log(`     fields      : ${JSON.stringify(doc.fields)}`);
  } else {
    console.log('  ⛔ документа нет — это текстовый ответ');
  }
  const pending = docgen.getPending(dialogue.id);
  const last = docgen.getLastDocgen(dialogue.id);
  console.log(
    `  состояние диалога: pending=${pending ? `${pending.template_key} ${JSON.stringify(pending.fields)}` : '—'}`
  );
  console.log(`                    last_docgen=${last ? last.template_key : '—'}`);
  return { saved, doc };
}

// вложение: выгрузка "Справка на сотрудника" из 1С:ЗиК

function makeCertificateXlsx() {
  const rows = [
    ['Справка на сотрудника', ''],
    ['ФИО', 'Иванова Мария Андреевна'],
    ['Дата рождения', '14.03.1985'],
    ['Занимаемая должность', 'Лаборант'],
    ['Структурное подразделение', 'Кафедра химии'],
    ['Образование', 'ТИУ, 2007, инженер-технолог'],
    [
      'Повышение квалификации',
      '12.05.2025 Охрана труда, 72 ч\n03.11.2024 Оказание первой помощи, 16 ч\n01.02.2015 Устаревший курс, 24 ч',
    ],
    [
      'Работа по окончании ВУЗа',
      '01.09.2007 Лаборант, Кафедра химии 1 Прием Основное место работы\n' +
        '01.09.2010 Лаборант, Кафедра химии 1 Перемещение Основное место работы\n' +
        '01.09.2015 Старший лаборант, Кафедра химии 1 Перемещение Основное место работы',
    ],
    ['Общий стаж', '18 лет'],
    ['Стаж работы в ТИУ', '18 лет'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Справка');
  const out = path.join(HERE, `_probe-certificate-${Date.now()}.xlsx`);
  fs.writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return {
    storedPath: out,
    filename: 'Справка на сотрудника.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: rows.map((r) => r.join(' | ')).join('\n'),
  };
}

// сценарии

const want = (n) => !ONLY.size || ONLY.has(n);
const tmpFiles = [];

try {
  // 1. Голая команда без данных: полей не извлеклось ->, уходим в
  //    обычный поток (RAG). Показываем это явно, чтобы не считать за регресс.
  if (want(1)) {
    await ask('Сценарий 1. «оформи приказ о приёме на работу» (без данных)', 'оформи приказ о приёме на работу');
  }

  // 2. Та же команда с данными -> документ (или диалоговый добор, если модель
  //    не вытащила часть обязательных полей).
  if (want(2)) {
    const r = await ask(
      'Сценарий 2. «оформи приказ о приёме…» с ФИО, должностью и окладом',
      'оформи приказ о приёме на работу Иванову Марию Андреевну на должность лаборанта с окладом 50000 с 1 августа 2026'
    );
    // 2б. Если сработал добор - досказываем и получаем документ.
    if (!r.doc && docgen.getPending(dialogue.id)) {
      await ask('Сценарий 2б. Ответ на уточняющий вопрос', 'сгенерируй как есть');
    }
  }

  // 3. Исправление уже созданного документа.
  if (want(3)) {
    if (!docgen.getLastDocgen(dialogue.id)) {
      console.log('\n(Сценарий 3 пропущен: в диалоге ещё нет созданного документа)');
    } else {
      await ask('Сценарий 3. «исправь дату на 5 мая» (поверх последнего документа)', 'исправь дату на 5 мая');
    }
  }

  // 4. Инструмент по вложению: справка на работника из выгрузки 1С:ЗиК.
  if (want(4)) {
    const att = makeCertificateXlsx();
    tmpFiles.push(att.storedPath);
    await ask('Сценарий 4. «сделай справку на работника» + xlsx-выгрузка', 'сделай справку на работника', [att]);
  }

  // 5. "Отмена" без активного оформления - подсказка вместо отказа RAG.
  if (want(5)) {
    await ask('Сценарий 5. «отмена» без активного оформления', 'отмена');
  }

  // 6. Диалоговый добор: часть обязательных полей не названа -> ассистент их
  //    спрашивает и запоминает pending, следующее сообщение досказывает.
  if (want(6)) {
    await ask(
      'Сценарий 6. Неполные данные → вопрос о недостающих полях',
      'оформи приказ о приёме на работу Иванову Марию Андреевну'
    );
    await ask('Сценарий 6б. Досказываем недостающее', 'должность лаборант, оклад 50000');
  }

  // 7. Инструмент А10: схема процесса из docx -> SVG в едином стиле ТИУ.
  if (want(7)) {
    const sample = path.resolve(ROOT, '..', 'backend', 'ИИ чат-бот', 'процессы', 'процесс аттестация ИИ.docx');
    if (!fs.existsSync(sample)) {
      console.log(`\n(Сценарий 7 пропущен: нет примера схемы ${sample})`);
    } else {
      await ask('Сценарий 7. «приведи схему к единому виду» + docx со схемой', 'приведи схему к единому виду', [
        {
          storedPath: sample,
          filename: path.basename(sample),
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: '[схема процесса]',
        },
      ]);
    }
  }
} finally {
  console.log(`\n${'═'.repeat(78)}`);
  for (const f of tmpFiles) fs.rmSync(f, { force: true });
  if (KEEP) {
    console.log(`Оставляю данные: dialogue=${dialogue.id}, docs=${created.docIds.join(',') || '—'}`);
  } else {
    // Каскад по FK снимет сообщения и вложения вместе с диалогом.
    await prisma.dialogues.delete({ where: { id: dialogue.id } }).catch(() => {});
    if (created.docIds.length) {
      await prisma.my_documents.deleteMany({ where: { id: { in: created.docIds } } }).catch(() => {});
    }
    for (const f of created.files) fs.rmSync(f, { force: true });
    console.log(`Прибрал за собой: диалог ${dialogue.id}, документов ${created.docIds.length}.`);
  }
  await prisma.$disconnect();
  // postGeneration у RAG-веток висит "в фоне" - не ждём его.
  process.exit(0);
}
