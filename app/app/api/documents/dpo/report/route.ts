import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import {
  DocValueError,
  docLinks,
  errText,
  firstSheet,
  readForm,
  readWorkbook,
  requireFile,
  sheetTextRows,
  uploadSuffix,
} from '@/lib/docs/common';
import { createDpoReport } from '@/lib/docs/dpo-report';

// Б2: отчёт по ДПО из xlsx-выгрузки 1С:ЗиК «ПК за период».
// Порт POST /api/documents/dpo/report из backend/routes/documents.py.
//
// LLM не используется — все числа считаются из таблицы.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const suffix = uploadSuffix(file);
  if (suffix !== '.xlsx' && suffix !== '.xlsm') {
    return badRequest('Ожидается xlsx-выгрузка «ПК за период» из 1С:ЗиК');
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 30 * 1024 * 1024) return badRequest('Файл больше 30 МБ');

  try {
    // openpyxl берёт первый лист книги (wb.worksheets[0]), а не активный.
    const rows = sheetTextRows(firstSheet(readWorkbook(data)));
    const { rec, text, stats } = await createDpoReport(gate.user.id, rows);
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      ...docLinks(rec.id),
      text,
      stats: {
        year: stats.year,
        total_people: stats.total_people,
        total_programs: stats.total_programs,
        total_records: stats.total_records,
        long_events: stats.long_events,
        short_events: stats.short_events,
      },
    });
  } catch (e) {
    if (e instanceof DocValueError) return badRequest(e.message);
    return NextResponse.json(
      { detail: `Не удалось сформировать отчёт: ${errText(e)}` },
      { status: 500 }
    );
  }
}
