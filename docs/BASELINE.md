# Baseline

Зафиксировано: 2026-09-15, рабочая копия `/mnt/c/OpnCod_Proj/gigachat-v2-connector` (@ `0a99a07`), фаза PHASE 0 / шаг 02 плана.

## Окружение

```text
Node:        v22.22.1
Bun:         1.4.2
OpenCode:    1.18.29
TypeScript:  5.7.2 (devDependency; запускается через bun)
```

## Скрипты package.json

```json
"scripts": {
  "build":     "bun build ./src/v2/index.ts --outfile=./dist/index.js --target=bun",
  "typecheck": "tsc --noEmit",
  "dev":       "bun run ./src/v2/index.ts"
}
```

Реальных эквивалентов `npm test` и `npm run lint` **нет**:
- `test` — отсутствует; в репозитории нет директории `tests/`, нет тест-раннера (jest/vitest/bun:test не настроен).
- `lint` — отсутствует; нет eslint-конфига и зависимостей.

## Результаты

```text
Tests:      N/A — нет тестов в репозитории
Lint:       N/A — нет lint-скрипта/конфига
Typecheck:  PASS (tsc --noEmit, strict)
Build:      PASS (dist/index.js, 0.52 MB, 145 модулей, ~106 ms)
```

## Наблюдения

1. Формат отчётов плана/инструкций (`npm test`, `npm run lint`) не применим 1:1 — необходимо определить эквиваленты:
   - вместо `npm test` → отсутствует (создать тест-инфраструктуру в рамках миграции; предлагаемый раннер: `bun:test` — bun уже в проекте);
   - вместо `npm run lint` → отсутствует (добавить на этапе стабилизации).
2. README ссылается на `/tmp/opencode/smoke-test.mjs` — файл в указанном месте **отсутствует** (документация расходится с фактом).
3. Тестовый сценарий для параллельных tool-calls (фикс `pendingCalls`) существует только как внешний артефакт, не входит в репозиторий.

## Вывод

Baseline **зелёный по typecheck/build**, но **неполный**: нет ни одного теста и lint. По правилам плана PHASE 0 требует не смешивать исправление старых проблем с миграцией V2. Состояние «чистого старта» приемлемо: существующий runtime работает, деградаций нет.

---

Далее: PHASE 1 — фиксация официального V2 contract и полноценная compatibility matrix.