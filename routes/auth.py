from __future__ import annotations

from fastapi import APIRouter, Depends, Form, Request, status
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from data.db_session import get_db
from data.users import User
from forms.auth import RegisterForm
from utils.security import hash_password, verify_password
from utils.templating import render

router = APIRouter(prefix="/auth", tags=["auth"])

_FIELD_LABELS = {
    "surname": "Фамилия", "name": "Имя", "patronymic": "Отчество",
    "username": "Логин", "email": "Корпоративная почта", "position": "Должность",
    "sex": "Пол", "password": "Пароль", "password_again": "Повтор пароля",
}


def _friendly_errors(exc: ValidationError) -> str:
    """Переводит технический дамп Pydantic в понятные пользователю сообщения."""
    msgs: list[str] = []
    for err in exc.errors():
        field = (err.get("loc") or [""])[0]
        label = _FIELD_LABELS.get(field, str(field))
        t = err.get("type", "")
        ctx = err.get("ctx", {}) or {}
        if field == "email":
            msgs.append("Некорректный адрес корпоративной почты")
        elif t == "string_too_short":
            msgs.append(f"«{label}»: минимум {ctx.get('min_length', '?')} симв.")
        elif t == "string_too_long":
            msgs.append(f"«{label}»: максимум {ctx.get('max_length', '?')} симв.")
        elif t == "missing":
            msgs.append(f"«{label}»: обязательное поле")
        elif t == "value_error":
            m = (err.get("msg") or "").replace("Value error, ", "").strip()
            msgs.append(m or f"«{label}»: некорректное значение")
        else:
            msgs.append(f"«{label}»: некорректное значение")
    # Убираем дубли, сохраняя порядок
    seen: set[str] = set()
    uniq = [m for m in msgs if not (m in seen or seen.add(m))]
    return "; ".join(uniq) or "Проверьте правильность заполнения полей"


@router.get("/login", name="auth_login_page")
async def login_page(request: Request):
    return render(request, "auth/login.html", {"errors": {}})


@router.post("/login", name="auth_login_submit")
async def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    # username — это либо логин, либо email, либо email из формы «логин + домен».
    user = (
        db.query(User)
        .filter((User.username == username) | (User.email == username))
        .first()
    )
    # Fallback: если ввели «ivanov@tyuiu.ru», но в БД лежит просто username='ivanov'
    if not user and "@" in username:
        local_part = username.split("@", 1)[0]
        user = db.query(User).filter(User.username == local_part).first()

    if not user or not verify_password(password, user.password_hash):
        return render(
            request,
            "auth/login.html",
            {"errors": {"common": "Неверный логин или пароль"}, "username": username},
        )
    if not user.is_active:
        return render(
            request,
            "auth/login.html",
            {"errors": {"common": "Учётная запись отключена"}},
        )
    request.session["user_id"] = user.id
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)


@router.get("/register", name="auth_register_page")
async def register_page(request: Request):
    return render(request, "auth/register.html", {"errors": {}, "values": {}})


@router.post("/register", name="auth_register_submit")
async def register_submit(
    request: Request,
    surname: str = Form(...),
    name: str = Form(...),
    patronymic: str | None = Form(default=None),
    username: str = Form(...),
    email: str = Form(...),
    position: str = Form(default="HR-специалист"),
    sex: str | None = Form(default=None),
    password: str = Form(...),
    password_again: str = Form(...),
    db: Session = Depends(get_db),
):
    values = {
        "surname": surname, "name": name, "patronymic": patronymic, "username": username,
        "email": email, "position": position, "sex": sex,
    }
    try:
        form = RegisterForm(
            surname=surname, name=name, patronymic=patronymic, username=username,
            email=email, position=position, sex=sex,
            password=password, password_again=password_again,
        )
    except ValidationError as e:
        return render(request, "auth/register.html", {"errors": {"common": _friendly_errors(e)}, "values": values})
    except Exception:
        return render(request, "auth/register.html", {"errors": {"common": "Проверьте правильность заполнения полей"}, "values": values})

    if db.query(User).filter((User.username == form.username) | (User.email == form.email)).first():
        return render(
            request,
            "auth/register.html",
            {"errors": {"common": "Пользователь с таким логином или email уже существует"}, "values": values},
        )

    user = User(
        username=form.username,
        email=form.email,
        password_hash=hash_password(form.password),
        surname=form.surname,
        name=form.name,
        patronymic=form.patronymic,
        position=form.position,
        sex=form.sex,
    )
    db.add(user)
    db.commit()
    request.session["user_id"] = user.id
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/logout", name="auth_logout")
async def logout(request: Request):
    request.session.clear()
    return JSONResponse({"success": True})
