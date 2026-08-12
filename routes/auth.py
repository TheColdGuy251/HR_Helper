from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Form, HTTPException, Request, status
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from data.db_session import get_db
from data.users import User
from forms.auth import RegisterForm
from utils.security import hash_password, verify_password
from utils.templating import render

router = APIRouter(prefix="/auth", tags=["auth"])

# JSON-эндпоинты для SPA-фронтенда (Next.js): те же проверки, что и у
# HTML-форм выше, но вход/выход/профиль отдаются в JSON без редиректов.
api_router = APIRouter(prefix="/api/auth", tags=["auth-api"])

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


# ---------------------------------------------------------------------------
# JSON API для SPA-фронтенда
# ---------------------------------------------------------------------------

def _find_user_by_login(db: Session, username: str) -> User | None:
    """Ищет пользователя по логину/почте (+ fallback на локальную часть почты)."""
    user = (
        db.query(User)
        .filter((User.username == username) | (User.email == username))
        .first()
    )
    if not user and "@" in username:
        local_part = username.split("@", 1)[0]
        user = db.query(User).filter(User.username == local_part).first()
    return user


def _user_json(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "surname": user.surname,
        "name": user.name,
        "patronymic": user.patronymic,
        "full_name": user.full_name,
        "short_name": user.short_name,
        "initials": user.initials,
        "position": user.position,
        "sex": user.sex or "unknown",
        "is_admin": user.is_admin,
        "is_kb_editor": user.is_kb_editor,
        "can_access_pii": user.can_access_pii,
    }


@api_router.post("/login")
async def api_login(
    request: Request,
    username: str = Body(...),
    password: str = Body(...),
    db: Session = Depends(get_db),
):
    user = _find_user_by_login(db, username.strip())
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Учётная запись отключена")
    request.session["user_id"] = user.id
    return {"success": True, "user": _user_json(user)}


@api_router.post("/register")
async def api_register(
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
):
    try:
        form = RegisterForm(
            surname=payload.get("surname"),
            name=payload.get("name"),
            patronymic=payload.get("patronymic") or None,
            username=payload.get("username"),
            email=payload.get("email"),
            position=payload.get("position") or "HR-специалист",
            sex=payload.get("sex") or None,
            password=payload.get("password"),
            password_again=payload.get("password_again"),
        )
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=_friendly_errors(e))
    except Exception:
        raise HTTPException(status_code=400, detail="Проверьте правильность заполнения полей")

    if db.query(User).filter((User.username == form.username) | (User.email == form.email)).first():
        raise HTTPException(
            status_code=409,
            detail="Пользователь с таким логином или email уже существует",
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
    return {"success": True, "user": _user_json(user)}


@api_router.get("/me")
async def api_me(request: Request):
    user = getattr(request.state, "user", None)
    if user is None:
        return JSONResponse({"user": None}, status_code=401)
    return {"user": _user_json(user)}


@api_router.post("/logout")
async def api_logout(request: Request):
    request.session.clear()
    return {"success": True}
