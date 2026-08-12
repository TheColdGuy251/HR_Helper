import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import { baseName, validationError } from '@/lib/news';
import {
  DocValueError,
  activeSheet,
  docLinks,
  errText,
  readForm,
  readWorkbook,
  sheetRows,
  uploadSuffix,
} from '@/lib/docs/common';
import { createAnnouncement, parseForm2Rows, type Form2 } from '@/lib/docs/pps-announcement';

// Б5: выгрузки «Форма 2» (по одному файлу на должность) → word-объявление
// о выборах заведующих кафедрами и конкурсе ППС.
// Порт POST /api/documents/pps/announcement из backend/routes/documents.py.

const XL_EXT = new Set(['.xls', '.xlsx', '.xlsm']);
const XL_LIST = '.xls/.xlsm/.xlsx';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request, 'files');
  if ('response' in form) return form.response;

  const files = form.form.getAll('files').filter((v): v is File => v instanceof File);
  if (!files.length) {
    // `files: list[UploadFile] = File(...)` — поле обязательное.
    return validationError(['body', 'files'], 'missing', 'Field required', null);
  }
  if (files.length > 20) return badRequest('Не больше 20 файлов за раз');

  const form2List: Form2[] = [];
  try {
    for (const file of files) {
      const suffix = uploadSuffix(file);
      if (!XL_EXT.has(suffix)) {
        return badRequest(`Неподдерживаемый формат: ${suffix || '?'} (нужен ${XL_LIST})`);
      }
      const data = Buffer.from(await file.arrayBuffer());
      if (data.length > 30 * 1024 * 1024) return badRequest('Файл больше 30 МБ');
      // В Python имя в тексте ошибки берётся у ВРЕМЕННОГО файла; здесь
      // подставляем исходное — так подсказка про «не ту» выгрузку полезнее.
      form2List.push(parseForm2Rows(sheetRows(activeSheet(readWorkbook(data))), baseName(file.name || '')));
    }

    const { rec, data } = await createAnnouncement(gate.user.id, form2List);
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      ...docLinks(rec.id),
      date: data.date,
      positions: data.positions,
      departments: data.departments,
      people: data.people,
      sections: data.sections.map(([header, lines]) => ({
        header: header.replace(/\n/g, ' '),
        count: lines.length,
      })),
    });
  } catch (e) {
    if (e instanceof DocValueError) return badRequest(e.message);
    return NextResponse.json(
      { detail: `Не удалось сформировать объявление: ${errText(e)}` },
      { status: 500 }
    );
  }
}
