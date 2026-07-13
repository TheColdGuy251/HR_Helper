from __future__ import annotations

import re
from io import BytesIO
from typing import Iterable

import cv2
import numpy as np
from PIL import Image

import pytesseract

from config import settings
from utils.logger import logger


_OCR_INITIALIZED = False

# Защита от OOM/зависаний на больших фото: ограничиваем сторону изображения
# и не запускаем дорогой денойз на крупных картинках (он ~квадратичен по площади).
_OCR_MAX_DIM = 2600
_OCR_DENOISE_MAX_PIXELS = 1_500_000
# Мелкие сканы распознаются плохо — апскейлим до этой минимальной длинной стороны.
_OCR_MIN_DIM = 1000
# Если качество распознавания ниже — пробуем дополнительные проходы/варианты.
_OCR_GOOD_QUALITY = 0.55
# Ниже этого порога считаем распознанное ненадёжным (флаг low_quality).
_OCR_MIN_QUALITY = 0.30

_WORD_RE = re.compile(r"[^\W\d_]{3,}", re.UNICODE)


def _init_tesseract() -> None:
    global _OCR_INITIALIZED
    if _OCR_INITIALIZED:
        return
    if settings.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd
    _OCR_INITIALIZED = True


def _ocr_quality(text: str) -> float:
    """Эвристическая оценка качества распознанного текста [0..1]: сочетание доли
    буквенных символов и доли символов, попавших в «слова» из ≥3 букв. Мусорный
    OCR (одиночные символы, спецзнаки) получает низкую оценку — по ней выбираем
    лучший из нескольких проходов и помечаем ненадёжный результат."""
    t = (text or "").strip()
    if len(t) < 3:
        return 0.0
    letters = sum(1 for ch in t if ch.isalpha())
    if letters == 0:
        return 0.0
    non_space = sum(1 for ch in t if not ch.isspace())
    alpha_ratio = letters / max(non_space, 1)
    word_chars = sum(len(w) for w in _WORD_RE.findall(t))
    word_ratio = word_chars / letters
    return round(alpha_ratio * 0.5 + word_ratio * 0.5, 4)


def _deskew(gray: np.ndarray) -> np.ndarray:
    """Выравнивает наклон скана (частая причина корявого OCR у фото документов).
    Угол оцениваем по «облаку» тёмных пикселей текста; правим только заметный,
    но не чрезмерный наклон (±0.5°…20°), чтобы не портить и без того ровные сканы."""
    try:
        inv = cv2.bitwise_not(gray)
        _, binv = cv2.threshold(inv, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        coords = cv2.findNonZero(binv)
        if coords is None:
            return gray
        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45:
            angle = 90 + angle
        if abs(angle) < 0.5 or abs(angle) > 20:
            return gray
        h, w = gray.shape[:2]
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        return cv2.warpAffine(
            gray, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
        )
    except cv2.error:
        return gray


def _to_gray(img: np.ndarray) -> np.ndarray:
    # Даунскейл крупных / апскейл мелких изображений: и то и другое ухудшает OCR
    # (крупные — память/время; мелкие — «рваные» глифы).
    h, w = img.shape[:2]
    longest = max(h, w)
    scale = 1.0
    if longest > _OCR_MAX_DIM:
        scale = _OCR_MAX_DIM / longest
    elif longest < _OCR_MIN_DIM:
        scale = min(_OCR_MIN_DIM / max(longest, 1), 3.0)
    if scale != 1.0:
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=interp)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if gray.shape[0] * gray.shape[1] <= _OCR_DENOISE_MAX_PIXELS:
        gray = cv2.fastNlMeansDenoising(gray, h=10)
    return _deskew(gray)


def _binarize(gray: np.ndarray) -> np.ndarray:
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10
    )


def _recognize(img: np.ndarray, lang: str, psm: int) -> str:
    return pytesseract.image_to_string(img, lang=lang, config=f"--oem 1 --psm {psm}")


def ocr_image_bytes(data: bytes, lang: str | None = None) -> str:
    """Распознаёт текст изображения. Делает несколько проверок качества:
    выравнивание наклона, бинаризация, и адаптивно — дополнительные проходы с
    другой сегментацией страницы (PSM) и по «чистому» серому, если первый проход
    получился низкого качества. Возвращает лучший по эвристике результат."""
    _init_tesseract()
    lang = lang or settings.ocr_languages
    img = np.array(Image.open(BytesIO(data)).convert("RGB"))[:, :, ::-1]  # to BGR
    gray = _to_gray(img)
    binimg = _binarize(gray)

    # Первый (основной) проход: бинаризованное изображение, PSM 6 (единый блок).
    best_text = _recognize(binimg, lang, 6)
    best_score = _ocr_quality(best_text)

    # Низкое качество — пробуем другую сегментацию и не-бинаризованный серый:
    # для колонок/таблиц лучше PSM 4, для чистых сканов иногда серый без порога.
    if best_score < _OCR_GOOD_QUALITY:
        for image, psm in ((binimg, 4), (gray, 6), (binimg, 3)):
            try:
                cand = _recognize(image, lang, psm)
            except pytesseract.TesseractError as e:  # pragma: no cover
                logger.debug("OCR-проход psm={} упал: {}", psm, e)
                continue
            score = _ocr_quality(cand)
            if score > best_score:
                best_text, best_score = cand, score
            if best_score >= _OCR_GOOD_QUALITY:
                break

    if best_score < _OCR_MIN_QUALITY:
        logger.info("OCR: низкое качество распознавания (score={:.2f})", best_score)
    return best_text


def ocr_pdf_pages(doc, page_indices: Iterable[int]) -> dict[int, str]:
    """Запускает OCR для перечисленных страниц PDF (fitz.Document)."""
    _init_tesseract()
    result: dict[int, str] = {}
    for idx in page_indices:
        try:
            page = doc.load_page(idx)
            pix = page.get_pixmap(dpi=200, alpha=False)
            img_bytes = pix.tobytes("png")
            text = ocr_image_bytes(img_bytes)
            result[idx] = text
        except Exception as e:
            logger.warning("OCR страницы {} не удался: {}", idx, e)
            result[idx] = ""
    return result
