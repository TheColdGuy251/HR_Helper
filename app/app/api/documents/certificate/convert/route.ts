import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import {
  DocValueError,
  activeSheet,
  docLinks,
  errText,
  readForm,
  readWorkbook,
  requireFile,
  sheetRows,
  uploadSuffix,
} from '@/lib/docs/common';
import { createCertificate } from '@/lib/docs/employee-certificate';

// Б3: выгрузка «Справка на сотрудника» из 1С:ЗиК → читабельный docx.
// Порт POST /api/documents/certificate/convert из backend/routes/documents.py.
//
// Старый .xls читает сам SheetJS, поэтому конвертация через LibreOffice
// (services/parsers/office_convert.py) здесь не нужна.

const XL_EXT = new Set(['.xls', '.xlsx', '.xlsm']);
/** Текст ошибки формата собирается так же, как в _save_upload_tmp. */
const XL_LIST = '.xls/.xlsm/.xlsx';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const suffix = uploadSuffix(file);
  if (!XL_EXT.has(suffix)) {
    return badRequest(`Неподдерживаемый формат: ${suffix || '?'} (нужен ${XL_LIST})`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 30 * 1024 * 1024) return badRequest('Файл больше 30 МБ');

  try {
    const rows = sheetRows(activeSheet(readWorkbook(data)));
    const { rec, fields } = await createCertificate(gate.user.id, rows);

    const preview: string[] = [];
    for (const name of ['Повышение квалификации', 'Работа по окончании ВУЗа']) {
      const val = fields[name];
      if (Array.isArray(val)) preview.push(`${name}: ${val.length} записей`);
    }
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      ...docLinks(rec.id),
      summary: preview.join('; ') || 'справка сформирована',
    });
  } catch (e) {
    if (e instanceof DocValueError) return badRequest(e.message);
    return NextResponse.json(
      { detail: `Не удалось сформировать справку: ${errText(e)}` },
      { status: 500 }
    );
  }
}
