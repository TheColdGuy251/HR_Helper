from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterForm(BaseModel):
    surname: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    patronymic: str | None = Field(default=None, max_length=64)
    username: str = Field(min_length=3, max_length=64)
    email: EmailStr
    position: str = Field(default="HR-специалист", max_length=128)
    sex: str | None = Field(default=None, max_length=16)
    password: str = Field(min_length=6, max_length=128)
    password_again: str = Field(min_length=6, max_length=128)

    @field_validator("password_again")
    @classmethod
    def passwords_match(cls, v, info):
        if "password" in info.data and v != info.data["password"]:
            raise ValueError("Пароли не совпадают")
        return v
