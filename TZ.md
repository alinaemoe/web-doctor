# Web Doctor — Техническое задание (v1.0)

> Статус: черновик на основе обсуждения. Пункты с пометкой **[DEFAULT]** — решение принято мной по умолчанию, можно оспорить. Раздел 20 — открытые вопросы.

---

## 1. Суть продукта

**Web Doctor** — developer-first «рабочее место для расследования проблем сайта». Не очередной сканер с 47 предупреждениями, а замкнутый цикл:

> найти проблему → показать её на реальной странице → объяснить → предложить исправление → **перепроверить** → отслеживать во времени.

### 1.1 Позиционирование
Не «первый инструмент, подсвечивающий ошибки» (WAVE, axe DevTools уже так делают), а **debugging workspace**, объединяющий категории проверок, доказательства, группировку по первопричине и верификацию исправлений.

### 1.2 Цели проекта
1. **Главная:** портфолио для найма — техническая глубина, чистая архитектура, убедительное демо, README, видео.
2. Работает в двух режимах: **локальный (CLI + web UI)** и **серверный (хостед веб-приложение)** на едином ядре.
3. В roadmap заложены (но НЕ реализуются в MVP): аккаунты, команды, биллинг, масштабирование.
4. Сроков нет — работаем по вехам, каждая веха должна быть демо-готовой. Ничего не подгоняем под дедлайны.

### 1.3 Аудитория (приоритет)
1. Frontend-разработчики — основная.
2. QA-инженеры (регрессии после релизов).
3. Позже: агентства, дизайнеры/контент-менеджеры (упрощённый режим отчёта).

---

## 2. Анализ аналогов и что берём/не берём

| Инструмент | Что умеет | Чего нет / слабое место | Что берём |
|---|---|---|---|
| **Lighthouse / Lighthouse CI** | perf, a11y, SEO, best practices; CI-бюджеты, сравнение запусков | Нет оверлея на странице, сравнение на уровне баллов, а не элементов | Lighthouse как модуль (v3); идею CI-ассертов |
| **Unlighthouse** (open source, MIT) | Lighthouse по всему сайту, обнаружение страниц из sitemap/роутов/краулинга, CLI + UI | Только Lighthouse; нет доказательств по элементам, нет workflow исправлений | Формат «npx + локальный UI»; discovery страниц |
| **WAVE** | Иконки проблем a11y прямо на странице | Только a11y, нет истории, нет API-first | Идея оверлея (но шире: все категории) |
| **axe DevTools / axe-core** | a11y правила, селектор, HTML, подсказки по исправлению | Только a11y, ручной запуск | Движок a11y (axe-core) |
| **Pa11y / pa11y-ci** | a11y в CI, мультиURL | Нет визуального инспектора | CLI-exit-коды и формат CI |
| **Screaming Frog** | Мощный SEO-краулер, много данных, экспорт, custom extraction | Десктоп, табличный UX, слабая визуализация, платный >500 URL | Глубина SEO-чеков, CSV-экспорт |
| **Sitebulb** | «Hints» с приоритетом и влиянием, карты краулинга, сравнение аудитов | Платный, SEO-ориентирован, не dev-инструмент | Приоритизация, crawl map |
| **DebugBear** | Мониторинг perf, регрессии, алерты | SaaS, не a11y/SEO-крауль, нет оверлея | Идея сравнения запусков/бюджетов |
| **Siteimprove** | Всё-в-одном для enterprise | Дорогой, не для разработчика | Отчёты для не-технарей (позже) |
| **Playwright Trace Viewer** | DOM-снимки, сеть, логи по действиям | Не аудит, нет правил | UX-ориентир для Network Detective |
| **OverlayQA / accessiBe visualizer** | Точки проблем на странице | Узкая ниша, закрытые | Подтверждает ценность оверлея |
| **Sentry** | Группировка по fingerprint, статусы issue, regression | Про рантайм-ошибки приложения | Модель Issue lifecycle + grouping |

**Вывод:** ни один инструмент не объединяет (а) все категории, (б) доказательства на уровне элемента, (в) группировку по первопричине, (г) verify-fix per issue, (д) историю на уровне issue. Это и есть дифференциатор.

---

## 3. Центральные «фишки» и приоритеты

Связка: **Root Cause Groups → Verify Fix → Regression Radar**, наглядный интерфейс — **Visual Inspector**. Все четыре в концепции; Visual Inspector и простая группировка — уже в MVP.

| # | Фича | Роль | MVP | v2 | v3 |
|---|---|---|---|---|---|
| 1 | Visual Inspector | Витрина | ✅ скрин + DOM-снимок + оверлей, Desktop/Mobile | — | Page states |
| 2 | Root Cause Groups | Главное отличие | ✅ простая (по ruleId + шаблонный fingerprint) | Улучшенная | Гипотезы общей причины (шаблон/компонент) |
| 3 | Verify Fix | Главный workflow | ✅ «Перепроверить эту проблему» для всех правил | Preview/Verified разделение в UI | Fix Preview (песочница) |
| 4 | Regression Radar | История | — | ✅ New/Open/Fixed/Reopened | Улучшенный матчинг, переименованные URL |

**Принципиальные формулировки:**
- Preview passed = правка устранила проблему в песочнице. Verified fixed = повторная проверка подтвердила исправление на реально обновлённой странице. Это разные статусы, не смешивать.
- Общая причина в группе — **гипотеза**, не факт; в UI помечается confidence.
- Если страница недоступна при новом запуске, её старые issue **не** переводятся в Fixed — статус `unverified`.

---

## 4. Нефункциональные принципы

1. **Доказательства, а не догадки.** Каждая issue содержит evidence; без evidence issue не создаётся.
2. **Честность результатов.** Три исхода проверки: `pass`, `fail`, `unverified` (не удалось проверить надёжно). Unverified ≠ Broken.
3. **Детерминизм.** В MVP нет ИИ; рекомендации — шаблоны на ruleId. ИИ — опциональный слой после v3.
4. **Severity ≠ Confidence.** Отдельные оси.
5. **Не выдавать за аудит больше, чем есть.** Базовые perf-измерения в MVP честно маркируются «diagnostic», а не «performance audit». Полный CWV/Lighthouse — v3.
6. **Автоматика не доказывает полную доступность.** В UI и отчётах постоянная пометка.
7. **Безопасность сканера** — SSRF-защита обязательна в серверном режиме (раздел 12).

---

## 5. Пользовательские сценарии

### 5.1 Главный демо-сценарий
1. Запуск `webdoctor scan https://localhost:4000` (Broken Shop, broken-режим) или ввод URL в вебе.
2. Краулинг с лимитами, сбор артефактов, прогон правил.
3. Результат: список issue + группы по первопричине.
4. Открываю issue → 3-панельный инспектор: список / страница с подсветкой элемента / детали (доказательство, объяснение, как исправить).
5. Исправляю Broken Shop (переключаю в fixed-режим или правлю код).
6. Нажимаю **Re-verify** на одной issue → `Verified fixed`.
7. Запускаю повторный полный скан → Regression Radar (v2): что New / Fixed / Reopened.

### 5.2 Дополнительные
- QA: `webdoctor scan --ci --fail-on high` в GitHub Actions, JSON-отчёт как артефакт.
- Разработчик: фильтр по категории/серьёзности/странице/viewport, игнор issue с причиной.
- Просмотр unverified: отдельный фильтр «Couldn't verify» с причиной (429, timeout, blocked, robots).

---

## 6. Функциональные требования

### 6.1 Запуск и управление сканированием
- FR-1.1 Ввод URL (валидация, нормализация, схемы http/https).
- FR-1.2 Настройки скана: max pages (по умолчанию 50 локально / 10 в публичном демо), max depth (3 / 2), viewports (Desktop 1366×768, Mobile 390×844), таймауты, user-agent, включение/выключение категорий, учёт robots.txt (по умолчанию уважаем), same-origin only (внешние — только проверка ссылок).
- FR-1.3 Статус: queued → running → completed / completed_with_warnings / failed / canceled; прогресс по страницам.
- FR-1.4 Отмена; частичные результаты сохраняются и помечаются.
- FR-1.5 Лимиты по общему времени (**[DEFAULT]** 10 мин локально / 3 мин демо), размеру артефактов, числу параллельных страниц (по умолчанию 3).
- FR-1.6 Повторный запуск тех же настроек одним кликом.

### 6.2 Краулинг
- FR-2.1 BFS от стартового URL; same-origin; нормализация URL (фрагменты, трекинг-параметры, trailing slash, регистр хоста).
- FR-2.2 Источники discovery: ссылки на странице, sitemap.xml (+ из robots.txt), опционально.
- FR-2.3 Учитывать canonical и noindex в метаданных, но не пропускать страницу автоматически.
- FR-2.4 Дедупликация по нормализованному URL и редиректам; защита от бесконечных календарей/фасетов (лимит на паттерн query-параметров **[DEFAULT]** 20 URL на путь).
- FR-2.5 Граф страниц (источник → цель) сохраняется для будущей визуализации (Cytoscape/React Flow — v3).
- FR-2.6 Дружелюбный rate-limit: параллельность на хост и задержка между запросами.

### 6.3 Сбор артефактов (на страницу × viewport)
- Полный скриншот (full page) + viewport-скриншот.
- Сериализованный DOM-снимок (после загрузки и автоскролла для lazy-load), с присвоением стабильных идентификаторов узлам (data-wd-id во время сбора, в снимке — не в живой страницы).
- bounding boxes для узлов, вовлечённых в issue.
- Network log (HAR-подобный: URL, метод, статус, тип ресурса, размер, тайминги, цепочки редиректов, initiator).
- Console messages (level, text, source).
- Заголовки ответа основной страницы.
- Performance Timing, размеры ресурсов, layout shifts (LayoutShift entries) с привязкой к узлам.
- Контекст проверки: viewport, UA, время, версия сканера, финальный URL.

### 6.4 Категории проверок (MVP)

#### A. Links & Resources
- Разделять **ошибки страницы** и **ошибки ресурсов** (страница 200, картинка 404 — разные issue с разными evidence).
- Внутренние ссылки: 4xx/5xx, редиректные цепочки (длина >2), редирект-циклы, смешанные http/https.
- Ресурсы: упавшие img/script/css/font/media, 4xx/5xx, CORS-блокировки, blocked by client.
- Внешние ссылки: проверяются HEAD→GET fallback; результаты 429, таймаут, 403 от антибот, DNS-ошибки → `unverified` с причиной, не `fail`. Кэш результатов на скан.
- Пустые/битые якоря (`#id` без целевого id).
- Evidence: URL, метод, статус, цепочка, referrer-страница, элемент-источник (селектор, outerHTML-фрагмент).

#### B. Accessibility (axe-core)
- Запуск axe-core на каждой странице и viewport. Не переписываем WCAG сами.
- Сохраняем: ruleId axe, impact, WCAG-теги, селектор(ы), HTML-фрагмент, failure summary, helpUrl.
- Результаты axe «incomplete/needs review» → `unverified`/«needs manual review», не fail.
- Постоянная пометка: автоматические проверки покрывают только часть WCAG.
- Дополнительные собственные проверки (минимально): пустая ссылка/кнопка по DOM, дубликаты id, image без alt (в SEO/a11y — один источник правды, без двойного учёта).

#### C. SEO Basics
- Title: отсутствует, пустой, слишком длинный/короткий (низкая severity), дубликаты между страницами (групповая проблема).
- Meta description: отсутствует/пустое/дубли.
- H1: нет; несколько H1 (severity low, confidence пониженная, не «critical»); пустой H1; пропуски уровней заголовков (info).
- Canonical: некорректный URL, ведёт на 404/редирект, на другой домен, несколько canonical.
- robots meta/X-Robots-Tag: noindex на страницах, которые достижимы из навигации (warning).
- robots.txt: недоступен/некорректен; sitemap.xml: недоступен, невалидный XML, URL в sitemap отдают не 200.
- Open Graph/Twitter основные теги (low).
- lang атрибут у `<html>`; viewport meta.
- Принцип: не объявлять любое отклонение критичным; severity калибруется таблицей правил.

#### D. Runtime & Diagnostics (MVP, без Lighthouse)
- Console errors/warnings (error — issue; warning — info), необработанные исключения, сгруппированные по сообщению.
- Failed requests (пересекается с A — дедуп по fingerprint evidence).
- Тяжёлые ресурсы: пороги (изображение >500 KB, JS >300 KB gzip, суммарный вес страницы >3 MB **[DEFAULT]**, настраиваемо).
- Изображения без width/height / с избыточным natural size относительно рендера (причина layout shift и лишнего веса).
- Layout shift: элементы со сдвигом (по LayoutShift API), без объявления «CLS score = Core Web Vitals».
- Horizontal overflow на Mobile; элементы, выходящие за viewport.
- Медленный ответ документа (TTFB выше порога) — как diagnostic с пометкой нестабильности измерения.
- **Маркировка:** раздел в UI называется «Runtime diagnostics», а не «Performance audit».

#### E. Lighthouse (v3, модуль)
- Опциональный запуск Lighthouse на выбранных страницах, отдельные issue/метрики, пометка «lab data», несколько прогонов и медиана, предупреждения о нестабильности окружения.
- Не смешивается с собственными diagnostic-метриками.

### 6.5 Единая модель Issue

```ts
type Severity = "critical" | "high" | "medium" | "low" | "info";
type Verdict  = "fail" | "unverified";            // pass не создаёт issue
type Status   = "new" | "open" | "fixed" | "reopened" | "ignored" | "unverified";

interface Issue {
  id: string;                    // uuid
  runId: string;
  ruleId: string;                // e.g. "a11y.axe.image-alt", "res.img.failed"
  category: "links-resources" | "accessibility" | "seo" | "runtime" | "performance";
  pageUrl: string;               // normalized
  viewport: "desktop" | "mobile" | "all";
  title: string;
  severity: Severity;
  confidence: number;            // 0..1, независимо от severity
  verdict: Verdict;
  unverifiedReason?: "rate_limited"|"timeout"|"blocked"|"dns"|"needs_manual_review"|"auth_required";
  status: Status;
  evidence: Evidence[];          // см. ниже, массив типизированных доказательств
  explanation: Explanation;      // what / where / why / howToFix
  fix?: FixSuggestion;           // before/after, docsUrl, verifyCriterion
  fingerprint: string;           // см. 6.7
  groupId?: string;              // Root Cause Group
  firstSeenRunId: string;
  lastSeenRunId: string;
  statusHistory: StatusChange[];
}

type Evidence =
  | { type: "dom";       selector: string; xpath?: string; htmlSnippet: string; boundingBox?: Box; nodeSignature: NodeSignature }
  | { type: "network";   requestUrl: string; method: string; status?: number; redirectChain?: string[]; resourceType: string; sizeBytes?: number; errorText?: string }
  | { type: "console";   level: string; text: string; source?: string }
  | { type: "screenshot";key: string; region?: Box }
  | { type: "metric";    name: string; value: number; threshold: number; unit: string }
  | { type: "headers";   name: string; value: string };
```

### 6.6 Explain the Problem
Для каждого `ruleId` — статический шаблон из четырёх частей: **What / Where / Why it matters / How to fix** (+ критерий успешной перепроверки и ссылка на документацию). Шаблоны лежат в пакете `rules`, версионируются, тестируются (snapshot). Подстановка параметров из evidence (URL, селектор, размер, статус). Без генерации ИИ.

### 6.7 Fingerprint (стабильная идентичность issue)
`fingerprint = hash(ruleId + normalizedPageKey + stableElementKey + evidenceKey)`
- `normalizedPageKey`: нормализованный путь без трекинг-параметров; для групп — шаблон пути (`/products/:slug`).
- `stableElementKey`: приоритеты — `id`/`data-testid` → роль + accessible name + нормализованный путь по DOM без индексов динамических классов → контекстная подпись (текст-соседи, структурный хэш).
- `evidenceKey`: для сети — нормализованный URL ресурса; для консоли — нормализованный текст без чисел/хэшей.
- Не использовать тексты сообщений рекомендаций и «красивые» заголовки.
- Мягкое сопоставление (fuzzy) при смене fingerprint — v3.

### 6.8 Root Cause Groups
MVP (простая):
- Группа = `ruleId` + «шаблон» элемента/ресурса (нормализованный селектор без индексов, общий URL ресурса, общий текст сообщения консоли).
- Показываем: «N страниц · M элементов · общий признак».
- Помечаем как `hypothesis` с confidence.

v2/v3:
- Определение шаблона страницы по структурному хэшу DOM-скелета и URL-паттерну (`/category/*`).
- Признаки общей причины: тот же селектор в шапке/подвале на всех страницах; одинаковый ресурс подключён на нескольких страницах; один template пропускает H1.
- Явное разделение: «вероятная причина» vs «подтверждено» (например, после Verify Fix на одной странице исчезло на всех).

### 6.9 Visual Inspector
- 3-панельный интерфейс: **слева** список/группы issue с фильтрами; **по центру** страница; **справа** детали.
- Центр: скриншот + оверлей bounding box; переключатель viewport (Desktop/Mobile); режим «скриншот» (всегда) и «DOM-снимок» (интерактивный, в sandboxed iframe — v2; в MVP достаточно скриншот + оверлей + HTML-фрагмент).
- hover по issue → подсветка; клик → фиксация, детали справа.
- Детали: severity/confidence, объяснение (4 части), evidence (DOM, сеть, консоль, метрика), before/after, ссылка на доку, кнопки: **Re-verify**, **Ignore (с причиной)**, **Copy selector / Copy as JSON**.
- Если сохранённого bounding box нет, элемент не найден или DOM изменился (Verify) — честная плашка «element can't be located reliably», показываем HTML-фрагмент вместо подсветки.
- Клавиатурные шорткаты: j/k навигация, Enter открыть, v re-verify, i ignore, f фильтры.
- Адаптивность самого UI и a11y самого продукта (оно должно проходить собственный аудит).

### 6.10 Verify Fix
- Кнопка Re-verify: запускает **только** нужное для этого issue правило на нужной странице/viewport (минимальный сбор артефактов).
- Результаты: `Verified fixed` (правило проходит, элемент/ресурс найден и корректен), `Still failing` (то же fingerprint), `Changed` (другой issue на том же элементе), `Couldn't verify` (страница недоступна/элемент не найден → не fixed).
- Для DOM-evidence повторный поиск элемента по `nodeSignature` (id → role+name → путь → контекст) с оценкой уверенности совпадения; при низкой уверенности — предупреждение.
- Результат фиксируется в `statusHistory` с метками времени и runId («verification run»).
- Re-verify группы: прогон по репрезентативным страницам (до N=5 **[DEFAULT]**) + статус «partially verified».

### 6.11 Regression Radar (v2)
- Сравнение любых двух запусков одного сайта (по умолчанию — с предыдущим).
- Статусы: `New`, `Open`, `Fixed`, `Reopened`, `Ignored`, `Unverified`.
- Правила перехода:
  - Не было → есть = New. Был Open/New → есть = Open. Был Open → нет **и страница успешно проверена** = Fixed. Был Fixed → снова есть = Reopened. Страница недоступна → Unverified (не Fixed).
- Дельты: количество issue по категориям, ухудшение метрик ресурсов (вес, число запросов), новые/исправленные группы.
- Сводка «since last run»; график тренда; фильтр «Only changes».
- Игнор: scoped (issue / правило на странице / правило на сайте), с причиной и опциональным сроком.

### 6.12 Fix Preview (v3)
- В изолированной копии страницы (Playwright-контекст с локальным snapshot-ресурсами или перехват ответа документа) пользователь/система применяет правку: атрибут, текст, CSS-свойство, вставка элемента.
- После правки запускается соответствующее правило. Результат: **Preview passed / failed**, before/after скриншоты, DOM-diff.
- Экспорт: unified diff для HTML-фрагмента и сниппет кода; формулировка «suggested change», **не** автоприменение к исходникам.
- Локальный режим v3+: опциональное применение патча к пути проекта только после просмотра diff и подтверждения (best effort, без source-map-магии).
- Ограничения честно показаны: DOM-правка ≠ изменение исходников.

### 6.13 Сеть и консоль (Network Detective, v2)
- Таймлайн запросов страницы, фильтры по типу/статусу, водопад, выделение цепочек редиректов, переход «issue ↔ запрос».
- Привязка console error к моменту/запросу.

### 6.14 Отчёты и экспорт
- MVP: JSON (полная схема, версия схемы), CSV (список issue), статический HTML-отчёт (один файл, со скриншотами, без внешних зависимостей).
- v2: сравнение двух запусков в отчёте.
- v3: PDF, shareable-ссылка на отчёт (серверный режим, публичная по токену, срок жизни).
- SARIF-вывод для интеграции с GitHub code scanning (опционально).

### 6.15 CLI
```
webdoctor scan <url> [--max-pages 50] [--depth 3] [--viewport desktop,mobile]
                     [--categories links,a11y,seo,runtime] [--out ./.webdoctor]
                     [--ci] [--fail-on high] [--format json,html,csv]
webdoctor ui [--port 7777]        # локальный web UI поверх ./.webdoctor
webdoctor verify <issue-id>
webdoctor compare <runA> <runB>   # v2
webdoctor demo                    # поднимает Broken Shop
```
- Exit-коды: 0 — ок, 1 — найдены issue ≥ порога (`--fail-on`), 2 — ошибка запуска, 3 — частичный результат/таймаут.
- Конфиг `webdoctor.config.ts|json` (zod-валидация).
- Установка: `npx webdoctor` (устанавливает Chromium через Playwright при первом запуске, с понятным сообщением).

### 6.16 Правила как плагины
Контракт правила:
```ts
interface Rule {
  id: string; category: Category; defaultSeverity: Severity;
  appliesTo: "page" | "site" | "resource";
  run(ctx: PageContext): Promise<RuleResult[]>;   // pass | fail(issue draft) | unverified
  explain(evidence): Explanation;
  verify(ctx, issue): Promise<VerifyResult>;
}
```
Новые правила не должны требовать изменений UI.

---

## 7. Приоритизация (Smart Prioritization)
`priorityScore = f(severity, confidence, affectedPages, recurrence, category weight)`
- Сортировка списка по приоритету по умолчанию; формула прозрачна и показана во «Why this priority?».
- Severity задаётся таблицей правил; confidence — правилом (например, 1.0 для 404 ресурса, 0.6 для «несколько H1»).

---

## 8. Архитектура

```
apps/
  web/        React + TS + Vite — UI (Inspector, Issue Explorer, Reports, Runs)
  api/        Fastify + TS — REST API, SSE для прогресса
  cli/        webdoctor (commander/cac)
packages/
  core/       типы Issue/Evidence/Run, fingerprint, нормализация URL, состояния
  scanner/    Playwright-оркестрация, краулер, сбор артефактов
  rules/      правила + шаблоны объяснений + тесты
  storage/    Drizzle-схемы, SQLite/Postgres драйверы, репозитории, artifact store (fs/S3)
  ui-kit/     общие компоненты (опционально)
  demo-site/  Broken Shop (broken/fixed режимы)
```
- **Единое ядро**: CLI и сервер используют `scanner` + `rules` + `storage` без дублирования.
- **Очередь:** локально — in-process (p-queue); сервер — BullMQ + Redis (воркеры отдельными процессами/контейнерами).
- **БД:** Drizzle; SQLite локально, PostgreSQL на сервере. Артефакты: файловая система локально, S3-совместимое (MinIO/R2) на сервере.
- **API:** REST + SSE прогресса; OpenAPI-схема из zod (fastify-zod / zod-to-openapi).
- **Версионирование:** схема отчёта и миграции БД версионируются.

### 8.1 Стек (зафиксировано)
TypeScript везде; pnpm-монорепо; React + Vite; чистый CSS + дизайн-токены (решение п.5 разд. 20); React Hook Form + Zod; Fastify; Playwright; axe-core; Lighthouse (v3); Drizzle; SQLite/PostgreSQL; BullMQ+Redis (server); Vitest, Testing Library, Playwright e2e; GitHub Actions; ESLint+Prettier; Changesets для релизов CLI **[DEFAULT]**.

### 8.2 Модель данных (основные сущности)
`Site` · `Run` (settings, status, startedAt, finishedAt, scannerVersion, stats, partial) · `Page` (run-level: url, finalUrl, status, depth, title, viewports) · `Artifact` (key, type, pageId, viewport, size) · `Issue` (раздел 6.5) · `IssueOccurrence` (issue × run, для истории) · `IssueGroup` (runId, ruleId, signature, hypothesis, confidence) · `StatusChange` · `IgnoreRule` · `ExternalLinkCache` · `VerificationRun`.
Для будущих аккаунтов: `User`, `Team`, `Project` — **таблицы не создаются в MVP**, но `Site` имеет nullable `ownerId`/`projectId`-задел.

---

## 9. Стабильность и качество измерений
- Ожидание готовности страницы: `networkidle` с верхним лимитом + дополнительная стабилизация DOM (MutationObserver quiet window) + автоскролл для lazy-load.
- Анимации/видео: отключение через `prefers-reduced-motion` для скриншотов; скрытие баннеров cookie **не** делается автоматически (фиксируем как есть); опция «dismiss selectors».
- Определение динамических SPA: учитывать клиентский роутинг при краулинге (ссылки из рендеренного DOM).
- Perf-диагностика: помечается как нестабильная; при сравнении запусков требуется схожесть окружения (viewport, throttling), иначе предупреждение.
- Таймауты и ретраи страниц (1 ретрай при сетевых ошибках навигации).

---

## 10. UI/UX
- Стиль: dev-tool, тёмная + светлая тема (+ system), плотные таблицы, моно-шрифт для кода, спокойная палитра с цветовым кодом severity (не только цветом — иконки/текст для a11y).
- Экраны: **Home / New Scan** · **Run Overview** (сводка, категории, группы, unverified) · **Inspector** · **Issue Explorer** (таблица, фильтры, сохранённые фильтры) · **Runs History** · **Compare** (v2) · **Settings** · **Report export**.
- Состояния: loading, empty, error, partial results, canceled.
- Собственная доступность UI: клавиатурная навигация, фокус-кольца, ARIA, контраст AA; инструмент проходит собственный аудит (CI).
- i18n-готовность: все строки через словарь (en по умолчанию; ru — второй локаль **[DEFAULT: позже]**).
- Адаптив: десктоп основной; на мобильном — упрощённый просмотр отчёта.

---

## 11. Демо-сайт «Broken Shop» (packages/demo-site)
Два режима: `broken` и `fixed` (переключатель env/endpoint). Набор намеренных дефектов, **каждому соответствует ожидаемое issue**:
- 404 изображения товара; шрифт 404; тяжёлый JS-бандл.
- Нет `alt`; input без label; низкий контраст; кнопка без имени.
- Нет H1 в шаблоне категории (18 страниц) → проверка Root Cause Groups.
- Два H1 на одной странице (ожидается low).
- Битая внутренняя ссылка из футера (повторяется на всех страницах).
- Редирект-цепочка из 3 хопов; редирект-петля.
- Canonical на 404; sitemap с 404 URL.
- Внешняя ссылка, возвращающая 429 → `unverified`.
- Console error на 2 страницах; mixed content.
- Изображение без width/height → layout shift; горизонтальный overflow на Mobile.
- Страница, недоступная во втором запуске (проверка «не считать Fixed»).
Файл-манифест `expected-issues.json` — эталон для e2e-тестов.

---

## 12. Безопасность

### 12.1 SSRF и сетевая изоляция (серверный режим, обязательно)
1. Допустимы только `http`/`https`; порты — allowlist (80, 443, 8080, 8443 **[DEFAULT]**).
2. Резолвинг DNS самим сервисом; проверка **всех** адресов; блок: loopback, RFC1918, link-local (169.254.0.0/16 вкл. metadata 169.254.169.254), CGNAT 100.64/10, multicast, reserved, IPv6 эквиваленты и IPv4-mapped IPv6.
3. **Pin IP**: соединение с проверенным IP, а не повторный резолв (защита от DNS rebinding). Для Playwright — через собственный forward-proxy, который резолвит, валидирует и пинит.
4. Валидация **каждого** редиректа и **каждого** подзапроса браузера (route-перехват для документов, ресурсов, fetch/XHR/WebSocket), а не только первого `goto`.
5. Лимит редиректов (≤ 10), размера ответа, времени, числа запросов на страницу.
6. Сетевая изоляция на уровне инфраструктуры: воркеры в контейнерах/netns с egress-firewall, запрещающим внутренние сети и metadata; нет облачных креденшелов у воркеров; IMDSv2 с hop limit 1.
7. Браузерный контекст на каждую задачу (свежий профиль), запрет скачиваний, запрет доступа к `file://`, ограничение ресурсов (CPU/RAM, лимит процессов), убийство по таймауту.
8. Публичное демо: ограничения (до 10 страниц, depth 2, один скан одновременно на IP, rate-limit, captcha-less квоты через IP+токен), только внешние публичные сайты + предустановленные примеры. Явный disclaimer «сканируйте только свои сайты»; соблюдение robots.txt по умолчанию; идентифицируемый User-Agent.
9. Тесты SSRF в CI (loopback, metadata, rebinding-стенд, редирект на внутренний адрес, IPv6, decimal/octal IP формы).

### 12.2 Локальный режим
- Сканирование localhost разрешено (это основной сценарий), но UI слушает только `127.0.0.1` по умолчанию; CORS закрыт; токен сессии для API.

### 12.3 Прочее
- Санитизация HTML-фрагментов при показе (никаких инъекций из сканируемого сайта в UI: DOM-снимки только в sandboxed iframe без скриптов); CSP на UI.
- Секреты — через env; зависимости — аудит (`pnpm audit`, Dependabot).
- Приватность: артефакты скана содержат контент чужого сайта — срок хранения в демо (**[DEFAULT]** 24 ч) и кнопка удаления.

---

## 13. Производительность и масштаб
- Параллельность страниц настраиваемая; лимит браузерных процессов; переиспользование browser, новые context на страницу.
- Потоковая запись результатов (не держать всё в памяти).
- Лимиты хранилища артефактов; сжатие скриншотов (WebP/JPEG с настройкой качества **[DEFAULT]**), дедупликация одинаковых ресурсов.
- Масштабирование (roadmap): горизонтальные воркеры, шардирование очереди по хостам, per-host throttling.

---

## 14. Тестирование
- **Unit** (Vitest): нормализация URL, fingerprint-стабильность, переходы статусов, правила на синтетических контекстах, шаблоны объяснений (snapshot).
- **Integration:** scanner против Broken Shop (broken/fixed) — сравнение с `expected-issues.json`.
- **E2E** (Playwright): главный сценарий — скан → инспектор → re-verify → повторный скан → Radar.
- **Contract-тесты** API (zod-схемы), миграции БД на SQLite и Postgres.
- **Security-тесты:** SSRF-матрица (12.1.9).
- **A11y самого UI:** axe в CI на ключевых экранах.
- **Flakiness:** повторные прогоны e2e, фиксированные сиды демо-сайта.
- Покрытие: целевое ≥ 80% для `core` и `rules`.
- Метрика качества правил: на корпусе из N размеченных страниц — precision/false-positive rate (v3).

---

## 15. CI/CD и DevOps
- GitHub Actions: lint, typecheck, unit, integration (Playwright + Chromium), e2e, security-тесты, сборка, публикация CLI в npm (Changesets) **[DEFAULT: опционально]**.
- Docker: образ воркера (Chromium + Playwright), docker-compose для сервера (api, worker, postgres, redis, minio).
- Деплой публичного демо: **[DEFAULT]** один VPS/Fly.io/Railway с лимитами; Cloudflare R2 для артефактов. Уточнить в разделе 20.
- Логи структурированные (pino), метрики базовые, healthcheck.

---

## 16. Документация и демонстрация (важно для портфолио)
- README: проблема → решение → GIF/скриншоты → быстрый старт `npx` → архитектура-диаграмма → сравнение с аналогами → roadmap.
- `docs/`: архитектура, модель Issue, как писать правило, безопасность сканера, ограничения (честный раздел «What Web Doctor can't tell you»).
- ADR-ы по ключевым решениям (fingerprint, SSRF, SQLite/Postgres, отказ от ИИ в MVP).
- Видео-демо 2–3 мин по сценарию 5.1.
- Публичная страница с живым демо.

---

## 17. Roadmap по вехам (без дедлайнов)

**M0 — Фундамент.** Монорепо, CI, `core` типы, Issue-модель, нормализация URL, `demo-site` каркас, `expected-issues.json`.
**M1 — Audit MVP.** Playwright-сканер одной страницы → краулинг с лимитами; сбор артефактов; правила A/C/D; axe (B); Explain-шаблоны; SQLite; CLI scan; JSON/CSV/HTML отчёт; фильтры.
**M2 — Visual Inspector (MVP).** Web UI: 3 панели, оверлей, Desktop/Mobile, фильтры, детали, unverified-фильтр, простая группировка Root Cause.
**M3 — Verify Fix.** Минимальный re-verify per issue и per group; NodeSignature и релокация; статусы Verified/Still failing/Couldn't verify.
**M4 — History + Regression Radar (v2).** Run history, fingerprint-идентичность, сравнение двух запусков, статусы New/Open/Fixed/Reopened/Ignored, Network Detective.
**M5 — Server mode.** ✅ Сделано: SSRF-защита (`packages/netguard`: IP-политика, pinned DNS, guarded fetch, прокси для Chromium) + e2e-матрица в реальном браузере, публичный режим (`webdoctor serve`: анонимные сессии, изоляция запусков по владельцу, лимиты/квоты, retention 24 ч), Docker/compose и `docs/security.md`, `docs/deploy.md`. **Отложено сознательно:** Postgres, Redis-очередь, S3 и несколько воркеров: для дешёвого VPS хватает одного контейнера с SQLite; хранилище и сканер уже за интерфейсами, переход — замена, а не переписывание.
**M6 — Polish.** ✅ HTML-отчёт (был с M1), CI-режим (аннотации и job summary в GitHub Actions, `docs/ci.md`), самоаудит a11y UI через axe в тестах (light/dark/375px), документация, сценарий видео (`docs/demo-script.md`).
**M7 (v3) — Углубление.** Сделано: граф страниц (карта сайта в UI, правила orphan/deep/dead-end, узкие места, вес ссылок в приоритете). Lighthouse-модуль, Fix Preview + патчи, умные Root Cause (шаблоны страниц), page states, Responsive/Accessibility Journey (клавиатура, фокус), граф страниц.
**Later:** аккаунты (GitHub OAuth), команды/роли, биллинг/квоты, shareable reports, интеграции Git, уведомления, расписания, опциональный ИИ-слой.

---

## 18. Вне MVP (намеренно)
ИИ-агент «чинит всё сам»; команды и роли; аутентифицированные сканы (логин в личные кабинеты); интеграции со всеми Git-провайдерами; юридические гарантии соответствия WCAG; бесконечный каталог правил; платежи и подписки; визуальный regression-diff скриншотов; мониторинг по расписанию.

---

## 19. Критерии готовности MVP (Definition of Done)
1. `npx webdoctor scan <Broken Shop broken>` находит ≥ 90% issue из `expected-issues.json` без ложных срабатываний сверх оговорённого допуска.
2. Все issue содержат evidence и 4-частное объяснение.
3. Внешняя ссылка с 429 помечена `unverified`, не `fail`.
4. UI: список → подсветка элемента на скриншоте (Desktop и Mobile) → детали → Re-verify.
5. Root Cause Groups: «нет H1 в шаблоне» схлопывается в одну группу с числом затронутых страниц.
6. Переключение Broken Shop в fixed → Re-verify даёт `Verified fixed`.
7. Отчёты JSON/CSV/HTML генерируются; JSON валидируется схемой.
8. Скан отменяется, частичные результаты сохраняются и помечены.
9. CI зелёный; README с быстрым стартом; сборка воспроизводима.
10. UI проходит собственный axe-аудит без critical/serious.

---

## 20. Принятые решения по открытым вопросам

| # | Вопрос | Решение |
|---|---|---|
| 1 | Название / npm | Web Doctor, пакет `webdoctor` (на 2026-10-15 свободен; `web-doctor` занят). Не публикуем до решения о публикации (п.6); домен и GitHub-org проверить отдельно |
| 2 | Хостинг демо | Дешёвый VPS (~$5/мес); конкретного провайдера выберем после M5. Всё провайдер-независимо (Docker Compose), egress-firewall на уровне VPS |
| 3 | Приоритет issue | `score = severity_weight × confidence × (1 + log2(affectedPages))`; веса: critical 100, high 60, medium 30, low 10, info 2. В UI — «Why this priority?» с расчётом |
| 4 | Русская локаль | После MVP (M6); в MVP только `en`, все строки через i18n-словарь |
| 5 | Стилизация UI | **Чистый CSS + дизайн-токены** (CSS-переменные, тёмная/светлая темы); без Tailwind/MUI. Для доступных примитивов (диалоги, табы, тултипы) допустимы headless-библиотеки без стилей — решить при реализации |
| 6 | Публикация CLI в npm | Отложено. Сначала локальная работа и репозиторий; Changesets/provenance — когда вернёмся к вопросу |
| 7 | DOM-снимок в инспекторе | В MVP нет: скриншот + оверлей + HTML-фрагмент. Интерактивный снимок (sandboxed iframe без скриптов) — v2 |
| 8 | robots.txt | Локально: уважать по умолчанию, флаг `--ignore-robots` для своих сайтов. Сервер: всегда уважать, флага нет. Цель — не получить претензий от чужих сайтов |
| 9 | Скриншоты | WebP ~80%, full-page до 10 000 px высоты, при превышении — обрезка с пометкой «page truncated» |
| 10 | Пресеты демо | Broken Shop + статичные документационные сайты с подходящей лицензией (example.com, копии MDN-подобных). Популярные реальные сайты — опционально, только если разрешают ToS. **Приоритет — режим «свой URL»** и реальная юзабельность, а не идеальная демо-витрина |
| 11 | A11y Journey (клавиатура, фокус, диалоги) | v3 |
| 12 | SARIF / GitHub Code Scanning | После M6, по желанию |

### 20.1 Изменения, внесённые этими решениями в остальные разделы
- Раздел 8.1: Tailwind заменён на чистый CSS + токены.
- Раздел 6.9: интерактивный DOM-снимок смещён на v2.
- Раздел 15: деплой — VPS, провайдер не фиксирован.
- Раздел 17 (M6): добавлены русская локаль; SARIF — опционально после M6; публикация в npm — отложена.

### 20.2 Остающиеся незакрытыми
- Домен и GitHub-организация под название.
- Конкретный VPS-провайдер и бюджет (после M5).
- Окончательные пороги правил (размеры ресурсов и т.п.) — уточняются на корпусе страниц при реализации.

---

## Приложение A. Матрица ruleId (стартовый набор)

| ruleId | Категория | Severity (default) | Confidence | Verify |
|---|---|---|---|---|
| `link.internal.broken` | links-resources | high | 1.0 | re-request |
| `link.internal.redirect-chain` | links-resources | low | 0.9 | re-request |
| `link.internal.redirect-loop` | links-resources | high | 1.0 | re-request |
| `link.external.broken` | links-resources | medium | 0.9 / unverified | re-request |
| `link.anchor.missing-target` | links-resources | low | 0.9 | DOM |
| `res.img.failed` | links-resources | high | 1.0 | page reload + request |
| `res.font.failed` | links-resources | medium | 1.0 | reload |
| `res.script.failed` | links-resources | high | 1.0 | reload |
| `res.css.failed` | links-resources | high | 1.0 | reload |
| `a11y.axe.*` | accessibility | by axe impact | 0.8–1.0 | rerun axe on node |
| `seo.title.missing` | seo | high | 1.0 | DOM |
| `seo.title.duplicate` | seo | low | 0.9 | site-level |
| `seo.description.missing` | seo | medium | 1.0 | DOM |
| `seo.h1.missing` | seo | medium | 0.9 | DOM |
| `seo.h1.multiple` | seo | low | 0.5 | DOM |
| `seo.canonical.invalid` | seo | medium | 0.9 | DOM+request |
| `seo.sitemap.unreachable` | seo | medium | 0.9 | request |
| `seo.robots.noindex-linked` | seo | medium | 0.7 | headers/DOM |
| `runtime.console.error` | runtime | medium | 0.8 | reload |
| `runtime.request.failed` | runtime | medium | 1.0 | reload |
| `runtime.resource.heavy` | runtime | low | 0.8 | reload |
| `runtime.img.no-dimensions` | runtime | low | 0.9 | DOM |
| `runtime.layout-shift.element` | runtime | low | 0.6 | reload (нестабильно) |
| `runtime.overflow-x.mobile` | runtime | medium | 0.9 | DOM+viewport |
| `runtime.mixed-content` | runtime | high | 1.0 | reload |

## Приложение B. Статусная машина issue

```
(нет) ──найдена──▶ new ──след. скан, есть──▶ open
                     │                           │
                     │                      след. скан, нет, страница проверена
                     ▼                           ▼
                  ignored                      fixed ──вернулась──▶ reopened ──▶ open
                     ▲
   страница недоступна ──▶ unverified (статус не меняется на fixed)
```

## Приложение C. Глоссарий
**Issue** — найденная проблема с доказательствами. **Rule** — проверка. **Fingerprint** — стабильный идентификатор issue между запусками. **Root Cause Group** — группа issue с вероятной общей причиной. **Unverified** — проверка не дала надёжного результата. **Verify Fix** — перепроверка конкретной issue. **Fix Preview** — проверка правки в песочнице без изменения исходников.
