import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import {
  DocValueError,
  activeSheet,
  boolForm,
  errText,
  readForm,
  readWorkbook,
  requireFile,
  sheetRows,
  uploadSuffix,
} from '@/lib/docs/common';
import { createInventory } from '@/lib/docs/dismissed-inventory';

// Б4: отчёт «Принято уволено» → xlsx-опись личных дел уволенных.
// Порт POST /api/documents/inventory/build из backend/routes/documents.py.

const XL_EXT = new Set(['.xls', '.xlsx', '.xlsm']);
const XL_LIST = '.xls/.xlsm/.xlsx';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const allCategories = boolForm(form.form, 'all_categories');
  if ('response' in allCategories) return allCategories.response;

  const suffix = uploadSuffix(file);
  if (!XL_EXT.has(suffix)) {
    return badRequest(`Неподдерживаемый формат: ${suffix || '?'} (нужен ${XL_LIST})`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 30 * 1024 * 1024) return badRequest('Файл больше 30 МБ');

  try {
    const rows = sheetRows(activeSheet(readWorkbook(data)));
    const { rec, result } = await createInventory(gate.user.id, rows, allCategories.value);
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      download_url: `/api/documents/${rec.id}/download`,
      year: result.year,
      count: result.items.length,
      fired_total: result.fired_total,
      skipped_rehired: result.skipped_rehired,
      items: result.items.slice(0, 200),
    });
  } catch (e) {
    if (e instanceof DocValueError) return badRequest(e.message);
    return NextResponse.json(
      { detail: `Не удалось сформировать опись: ${errText(e)}` },
      { status: 500 }
    );
  }
}
