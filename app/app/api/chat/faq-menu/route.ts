import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { asList, pyStr } from '@/lib/kb';
import { baseName } from '@/lib/news';

// Меню быстрого набора FAQ: категории → вопросы (блоки) → под-ветки.
// Порт GET /api/chat/faq-menu (backend/routes/chat.py: faq_menu).
// Финальная кнопка отправляет сообщение с faq_id → точный курируемый ответ.

// Человеческие названия категорий по файлам-источникам FAQ.
const FAQ_CATEGORY_LABELS: [string, string][] = [
  ['охрана труда', 'Охрана труда'],
  ['аттестация ауп', 'Аттестация АУП и УВП'],
  ['аттестация пр', 'Аттестация ПР'],
  ['конкурс', 'Конкурс, гранты, соцпрограмма'],
  ['обучение', 'Обучение, вакансии, награды'],
];

/** Path(...).stem: имя файла без последнего расширения. */
function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Python str.strip(" -–_"): срезает перечисленные символы с обоих концов. */
function stripChars(s: string): string {
  return s.replace(/^[ \-–_]+/, '').replace(/[ \-–_]+$/, '');
}

function faqCategory(sourceFile: string | null): string {
  const low = (sourceFile || '').toLowerCase();
  for (const [key, label] of FAQ_CATEGORY_LABELS) {
    if (low.includes(key)) return label;
  }
  const s = stripChars(stem(baseName(sourceFile || 'FAQ')).replace('чат-бот', ''));
  return s ? s.slice(0, 1).toUpperCase() + s.slice(1) : 'Прочее';
}

interface MenuItem {
  block: string;
  question: string;
  label: string;
  options?: { id: number; label: string }[];
  id?: number;
}

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const rows = await prisma.faq_entries.findMany({
    where: { is_active: true },
    orderBy: [{ source_file: 'asc' }, { group_key: 'asc' }, { position: 'asc' }],
  });

  type Row = (typeof rows)[number];
  const groups = new Map<string, { head: Row | null; subs: Row[] }>();
  for (const e of rows) {
    let g = groups.get(e.group_key);
    if (!g) {
      g = { head: null, subs: [] };
      groups.set(e.group_key, g);
    }
    if (e.position === 0) g.head = e;
    else g.subs.push(e);
  }

  const categories = new Map<string, MenuItem[]>();
  for (const g of groups.values()) {
    const head = g.head ?? (g.subs.length ? g.subs[0] : null);
    if (!head) continue;

    const variants = asList(head.variants)
      .map((v) => (v ? pyStr(v).trim() : ''))
      .filter((v) => v.length > 3);
    const block = (head.block || '').trim();
    // В части файлов первый «вариант» — путь категории, совпадающий с названием
    // блока: из-за него всё меню состояло из одинаковых кнопок. Настоящий вопрос —
    // первый вариант, не повторяющий блок (вопросительный — в приоритете).
    const meaningful = variants.filter((v) => v.toLowerCase() !== block.toLowerCase());
    const question =
      meaningful.find((v) => v.replace(/\s+$/u, '').endsWith('?')) ||
      meaningful[0] ||
      block ||
      'Вопрос';

    const item: MenuItem = {
      block: block || question,
      question,
      label: block || question,
    };
    if (g.subs.length) {
      item.options = g.subs.map((s, i) => ({
        id: s.id,
        label: (s.option_label || '').split(' / ')[0] || `Вариант ${i + 1}`,
      }));
    } else {
      item.id = head.id;
    }

    const cat = faqCategory(head.source_file);
    const list = categories.get(cat);
    if (list) list.push(item);
    else categories.set(cat, [item]);
  }

  // Если подпись повторяется внутри категории — показываем сам вопрос.
  for (const items of categories.values()) {
    const counts = new Map<string, number>();
    for (const i of items) {
      const k = i.label.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const i of items) {
      if ((counts.get(i.label.toLowerCase()) ?? 0) > 1) i.label = i.question;
    }
    items.sort((a, b) => {
      const x = a.label.toLowerCase();
      const y = b.label.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  return NextResponse.json({
    success: true,
    categories: [...categories.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([label, items]) => ({ label, items })),
  });
}
