// Автотесты генераторов документов (node --test, без БД/LLM/Qdrant).
//
// Модули lib/** - TypeScript с алиасом "@/", поэтому грузим их через jiti -
// тем же способом, что и probe-скрипты рядом.
//
// Запуск: npm test  (или node --test scripts/tests)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import PizZip from 'pizzip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Prisma-клиент создаётся при импорте lib/db, но к базе тесты не ходят.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': ROOT,
    'server-only': path.join(ROOT, 'node_modules/next/dist/compiled/server-only/empty.js'),
  },
});
const load = (rel) => jiti.import(path.join(ROOT, rel));

// Б5: объявление конкурса ППС

test('deptDisplay: обычная кафедра — с маленькой буквы, аббревиатуры не коверкаются', async () => {
  const { deptDisplay } = await load('lib/docs/pps-announcement.ts');
  // Отзыв УРП от 21.07: в объявлении выходило "аО "Мостострой-11"", "оОО ...".
  assert.equal(deptDisplay('АО "Мостострой-11"'), 'АО "Мостострой-11"');
  assert.equal(deptDisplay('ООО "Газпром ВНИИГАЗ"'), 'ООО "Газпром ВНИИГАЗ"');
  assert.equal(deptDisplay('Базовая кафедра АО СУЭНКО'), 'АО СУЭНКО');
  assert.equal(
    deptDisplay('Кафедра архитектуры и градостроительства'),
    'архитектуры и градостроительства'
  );
  assert.equal(deptDisplay('Академический офис'), 'академический офис');
});

// Б3: справка на работника

const TODAY = Date.UTC(2026, 6, 21); // 21.07.2026 - день тестирования УРП

test('справка: ПК только за последние 3 года', async () => {
  const { buildCertificateFields } = await load('lib/docs/employee-certificate.ts');
  const fields = buildCertificateFields(
    {
      'ФИО': 'Иванов Иван Иванович',
      'Повышение квалификации':
        '15.08.2020,Старый институт,Забытая программа\n' +
        '15.08.2025,Новый институт,Свежая программа\n' +
        'строка без даты остаётся',
    },
    TODAY
  );
  const pk = fields['Повышение квалификации'];
  assert.equal(pk.length, 2);
  assert.ok(pk[0].includes('2025'));
  assert.ok(pk[1].includes('без даты'));
});

test('справка: подряд идущие приказы одной должности схлопываются, хвосты убираются', async () => {
  const { buildCertificateFields } = await load('lib/docs/employee-certificate.ts');
  const fields = buildCertificateFields(
    {
      'ФИО': 'Иванов Иван Иванович',
      'Работа по окончании ВУЗа':
        '23.01.2014,Доцент,Кафедра строительных материалов 0,5 Перемещение Основное место работы\n' +
        '01.09.2015,Доцент,Кафедра строительных материалов\n' +
        '01.09.2016,Профессор,Кафедра строительных материалов',
    },
    TODAY
  );
  const work = fields['Работа по окончании ВУЗа'];
  assert.equal(work.length, 2);
  assert.ok(work[0].startsWith('23.01.2014'), 'остаётся ПЕРВАЯ дата должности');
  assert.ok(!work[0].includes('Перемещение'), 'служебный хвост приказа убран');
  assert.ok(work[1].startsWith('01.09.2016'));
});

test('справка: валидация дат — предупреждения, а не ошибки', async () => {
  const { validateCertificate } = await load('lib/docs/employee-certificate.ts');

  // Случай из отзыва УРП: "Дата рождения: 16.11.0000".
  const bad = validateCertificate(
    {
      'ФИО': 'Иванов Иван Иванович',
      'Дата рождения': '16.11.0000',
      'Занимаемая должность': 'Доцент',
      'Структурное подразделение': 'Кафедра',
    },
    TODAY
  );
  assert.equal(bad.length, 1);
  assert.match(bad[0], /Дата рождения/);
  assert.match(bad[0], /16\.11\.0000/);

  // Нормальные данные - предупреждений нет.
  const ok = validateCertificate(
    {
      'ФИО': 'Иванов Иван Иванович',
      'Дата рождения': '16.11.1980',
      'Занимаемая должность': 'Доцент',
      'Структурное подразделение': 'Кафедра',
      'Повышение квалификации': '15.08.2025,Институт,Программа',
    },
    TODAY
  );
  assert.deepEqual(ok, []);

  // Отсутствующие поля и невозможные даты в списках.
  const missing = validateCertificate({ 'ФИО': 'Иванов', 'Повышение квалификации': '31.02.2025,X,Y' }, TODAY);
  assert.ok(missing.some((w) => w.includes('Дата рождения')));
  assert.ok(missing.some((w) => w.includes('Занимаемая должность')));
  assert.ok(missing.some((w) => w.includes('Повышение квалификации')));
});

// Б4: опись личных дел уволенных

function invRows(extra = []) {
  const header = [
    'Дата записи о гражданстве', 'Сотрудник', 'Подразделение', 'Полная иерархия',
    'Должность', 'Категория', 'Количество ставок', 'Вид события',
  ];
  const row = (date, fio, pos, cat, rate, event) => [date, fio, 'Отдел', 'Иерархия-Отдел', pos, cat, rate, event];
  return [
    ['Параметры:'],
    header,
    row('04.11.2026 0:00:05', 'Петров Пётр Петрович (осн.)', 'Специалист', 'АУП', '1', 'Увольнение'),
    row('01.03.2026 0:00:05', 'Сидорова Анна Ивановна (осн.)', 'Инженер', 'АУП', '1', 'Увольнение'),
    row('15.04.2026 0:00:20', 'Сидорова Анна Ивановна (вн. совм.)', 'Инженер', 'АУП', '0.5', 'Прием'),
    row('10.05.2026 0:00:05', 'Козлов Иван Ильич (осн.)', 'Доцент', 'ППС', '1', 'Увольнение'),
    ...extra,
  ];
}

test('опись: повторно принятые исключаются, дата = дата записи − 1 день', async () => {
  const { analyzeDismissedRows } = await load('lib/docs/dismissed-inventory.ts');
  const res = analyzeDismissedRows(invRows());
  // Сидорова принята повторно (пусть и другой вид занятости) - не в описи;
  // Козлов - ППС, отсекается фильтром категорий административного блока.
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].fio, 'Петров Пётр Петрович (осн.)');
  assert.equal(res.items[0].dismissed_at, '03.11.2026');
  assert.equal(res.skipped_rehired, 1);
  assert.equal(res.year, 2026);
  assert.deepEqual(res.warnings, []);
});

test('опись: совместительства схлопываются в одну строку, битые даты дают предупреждение', async () => {
  const { analyzeDismissedRows } = await load('lib/docs/dismissed-inventory.ts');
  const res = analyzeDismissedRows(
    invRows([
      ['04.11.2026 0:00:05', 'Петров Пётр Петрович (вн. совм.)', '', '', 'Лаборант', 'УВП', '0.5', 'Увольнение'],
      ['дата не разобралась', 'Новикова Ольга Петровна (осн.)', '', '', 'Методист', 'УВП', '1', 'Увольнение'],
    ])
  );
  // Не просто "Петров": у Новиковой отчество "Петровна" тоже его содержит.
  const petrov = res.items.filter((it) => it.fio.includes('Петров Пётр'));
  assert.equal(petrov.length, 1, 'две ставки одного человека — одна строка описи');
  assert.ok(petrov[0].position.includes('Специалист') && petrov[0].position.includes('Лаборант'));
  assert.ok(res.warnings.some((w) => w.includes('не разобралась')));
});

// Конструктор docx: рамка под фото и встроенная картинка

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

test('docx: картинка попадает в word/media, rels и content-types', async () => {
  const { buildDocx } = await load('lib/docs/docx.ts');
  const buf = buildDocx([
    {
      frame: { widthPt: 100, heightPt: 128, border: true },
      align: 'center',
      runs: [{ text: '', image: { data: PNG_1PX, ext: 'png', widthPt: 90, heightPt: 120 } }],
    },
    { runs: [{ text: 'СПРАВКА', bold: true }], align: 'center' },
  ]);
  const zip = new PizZip(buf);
  assert.ok(zip.files['word/media/image1.png'], 'медиа-часть добавлена');
  const doc = zip.files['word/document.xml'].asText();
  assert.ok(doc.includes('<w:framePr'), 'абзац с фото — плавающая рамка');
  assert.ok(doc.includes('r:embed="rIdImg1"'));
  const rels = zip.files['word/_rels/document.xml.rels'].asText();
  assert.ok(rels.includes('media/image1.png'));
  const types = zip.files['[Content_Types].xml'].asText();
  assert.ok(types.includes('Extension="png"'));
});

test('docx: документ без картинок собирается по-старому (без media и лишних деклараций)', async () => {
  const { buildDocx } = await load('lib/docs/docx.ts');
  const zip = new PizZip(buildDocx([{ runs: [{ text: 'Привет' }] }]));
  assert.ok(!Object.keys(zip.files).some((n) => n.startsWith('word/media/')));
  assert.ok(!zip.files['[Content_Types].xml'].asText().includes('image/png'));
});

// Фото из книги Excel

test('workbook-image: фото достаётся из xl/media книги .xlsx', async () => {
  const { extractWorkbookPhoto } = await load('lib/docs/workbook-image.ts');
  const zip = new PizZip();
  zip.file('xl/media/image1.png', PNG_1PX);
  zip.file('xl/workbook.xml', '<workbook/>');
  const book = zip.generate({ type: 'nodebuffer' });

  const photo = await extractWorkbookPhoto(book, '.xlsx');
  assert.ok(photo, 'фото найдено');
  assert.equal(photo.ext, 'png');
  assert.equal(photo.width, 1);
  assert.equal(photo.height, 1);

  const empty = new PizZip();
  empty.file('xl/workbook.xml', '<workbook/>');
  assert.equal(await extractWorkbookPhoto(empty.generate({ type: 'nodebuffer' }), '.xlsx'), null);
});
