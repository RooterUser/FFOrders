import { DEFAULT_TARIFFS, IS_LOCAL_PREVIEW } from "./config.js";
import { escapeHtml, maskTgId, rubToKopecks, formatMoney, getTimestampMs, getCurrentMonthKey } from "./formatters.js";
import { calculateMetrics } from "./finance.js";
import { authenticateUser } from "./auth.js";
import * as Repo from "./repository.js";

const state = {
    user: null,
    usersMap: {},
    tariffs: { ...DEFAULT_TARIFFS },
    pendingEvents: [],
    approvedEvents: [],
    monthHistory: [],
    historyCursor: null,
    isLoadingHistory: false,
    selectedMonth: getCurrentMonthKey(),
    ownerTab: "dashboard",
    unsubs: []
};

// Генератор уникального ID запроса для трассировки ошибок
function reqId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function showToast(msg, isError = false) {
    const toast = document.getElementById("toast");
    toast.textContent = isError ? `${msg} [Код: ${reqId()}]` : msg;
    toast.classList.add("toast-visible");
    setTimeout(() => toast.classList.remove("toast-visible"), 3200);
}

// Модальное окно подтверждения перед критическими операциями
function askConfirm(title, text) {
    return new Promise((resolve) => {
        const modal = document.getElementById("confirmModal");
        document.getElementById("confirmTitle").textContent = title;
        document.getElementById("confirmText").textContent = text;
        modal.classList.remove("hidden");

        const cleanup = (result) => {
            modal.classList.add("hidden");
            resolve(result);
        };
        document.getElementById("confirmOkBtn").onclick = () => cleanup(true);
        document.getElementById("confirmCancelBtn").onclick = () => cleanup(false);
    });
}

// Мониторинг сети (Offline / Online)
function setupNetworkWatcher() {
    const banner = document.getElementById("offlineBanner");
    const syncDot = document.getElementById("syncIndicator");
    const updateStatus = () => {
        if (!navigator.onLine) {
            banner.classList.remove("hidden");
            syncDot.className = "w-2 h-2 rounded-full bg-red-500 shrink-0";
        } else {
            banner.classList.add("hidden");
            syncDot.className = "w-2 h-2 rounded-full bg-green-500 shrink-0";
        }
    };
    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);
    updateStatus();
}

async function loadHistory(reset = false) {
    if (state.isLoadingHistory) return;
    state.isLoadingHistory = true;
    if (reset) {
        state.monthHistory = [];
        state.historyCursor = null;
    }
    render();

    try {
        const { items, nextCursor } = await Repo.fetchMonthHistoryPage(state.selectedMonth, state.historyCursor, 25);
        state.monthHistory = reset ? items : [...state.monthHistory, ...items];
        state.historyCursor = nextCursor;
    } catch (e) {
        showToast("Ошибка загрузки истории", true);
    } finally {
        state.isLoadingHistory = false;
        render();
    }
}

function startListeners() {
    state.unsubs.forEach((u) => u());
    state.unsubs = [];

    state.unsubs.push(
        Repo.subscribeTariffs((t) => { state.tariffs = t; render(); }, () => showToast("Ошибка тарифов", true)),
        Repo.subscribeUsers((u) => { state.usersMap = u; render(); }, () => showToast("Ошибка списка команды", true)),
        Repo.subscribePendingEvents((list) => { state.pendingEvents = list; render(); }, () => showToast("Ошибка заявок", true)),
        Repo.subscribeApprovedBalances((list) => { state.approvedEvents = list; render(); }, () => showToast("Ошибка балансов", true))
    );
}

async function bootstrap() {
    setupNetworkWatcher();
    try {
        state.user = await authenticateUser();
        document.getElementById("loadingScreen").classList.add("hidden");
        document.getElementById("dashboard").classList.remove("hidden");

        const monthInput = document.getElementById("monthSelector");
        monthInput.classList.remove("hidden");
        monthInput.value = state.selectedMonth;
        monthInput.onchange = (e) => {
            state.selectedMonth = e.target.value;
            loadHistory(true);
        };

        // Локальный переключатель ролей (только на localhost)
        if (IS_LOCAL_PREVIEW) {
            const devBar = document.getElementById("devBar");
            const devSelect = document.getElementById("devUserSelect");
            devBar.classList.remove("hidden");
            devSelect.innerHTML = `
                <option value="owner">👑 Владелец (Local)</option>
                <option value="fulfillment">📦 Фулфилмент (Local)</option>
                <option value="courier">🚚 Курьер (Local)</option>
            `;
            devSelect.onchange = (e) => {
                state.user = { ...state.user, role: e.target.value };
                render();
            };
        }

        startListeners();
        await loadHistory(true);
    } catch (err) {
        const app = document.getElementById("app");
        if (err.message === "NO_TELEGRAM_CONTEXT") {
            app.innerHTML = `
                <div class="tg-card text-center py-10 my-10 border border-amber-200 bg-amber-50">
                    <div class="text-3xl mb-3">⚠️</div>
                    <h2 class="font-bold text-amber-900 text-lg mb-2">Доступ ограничен</h2>
                    <p class="text-sm text-amber-800 px-2">Откройте приложение исключительно внутри Telegram Mini App.</p>
                </div>`;
        } else {
            app.innerHTML = `
                <div class="tg-card text-center py-10 my-10 border border-red-200 bg-red-50">
                    <div class="text-3xl mb-3">🚫</div>
                    <h2 class="font-bold text-red-900 text-lg mb-2">Ошибка авторизации</h2>
                    <p class="text-sm text-red-700 mb-4 px-2">${escapeHtml(err.message)}</p>
                    <a href="https://t.me/ddr712" target="_blank" class="inline-block bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-xl text-sm">Администратор (@ddr712)</a>
                </div>`;
        }
    }
}

// =========================================================================
// ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ДЕЙСТВИЙ (С БЛОКИРОВКОЙ DOUBLE-SUBMIT)
// =========================================================================
window.appActions = {
    async claimTask(id, btn) {
        btn.disabled = true;
        try {
            await Repo.claimTaskTx(id, state.user.id);
            showToast("Задание принято!");
            loadHistory(true);
        } catch (e) {
            showToast(e.message, true);
            btn.disabled = false;
        }
    },

    async approveEvent(id, expectedType, btn) {
        const ok = await askConfirm("Подтверждение операции", "Подтвердить приемку / оплату? Отменить это действие позже будет невозможно.");
        if (!ok) return;
        btn.disabled = true;
        try {
            await Repo.approvePendingTx(id, state.user.id, expectedType);
            showToast("Успешно подтверждено!");
            loadHistory(true);
        } catch (e) {
            showToast(e.message, true);
            btn.disabled = false;
        }
    },

    async cancelEvent(id, btn) {
        const ok = await askConfirm("Отмена операции", "Перевести запись в статус «Отменено»? Запись останется в журнале аудита.");
        if (!ok) return;
        if (btn) btn.disabled = true;
        try {
            await Repo.cancelPendingTx(id, state.user.id);
            showToast("Операция отменена");
            loadHistory(true);
        } catch (e) {
            showToast(e.message, true);
            if (btn) btn.disabled = false;
        }
    },

    switchTab(tab) {
        state.ownerTab = tab;
        render();
    },

    loadMore() {
        loadHistory(false);
    }
};

// =========================================================================
// ОТРИСОВКА ИНТЕРФЕЙСА
// =========================================================================
function render() {
    if (!state.user) return;
    const roleLabel = state.user.role === "owner" ? "Владелец" : state.user.role === "fulfillment" ? "Фулфилмент" : "Курьер";
    document.getElementById("appTitle").textContent = `${state.user.name} (${roleLabel})`;

    const monthApproved = state.approvedEvents.filter((e) => e.monthKey === state.selectedMonth);
    const metrics = calculateMetrics(state.approvedEvents, state.pendingEvents, monthApproved, state.user.id);
    const container = document.getElementById("dashboard");

    if (state.user.role === "fulfillment") renderFulfillment(container, metrics);
    else if (state.user.role === "courier") renderCourier(container, metrics);
    else if (state.user.role === "owner") renderOwner(container, metrics);
}

function renderFulfillment(container, metrics) {
    const pendingBoxes = state.pendingEvents.filter((e) => e.type === "boxes");
    const pendingBoxesHtml = pendingBoxes.length ? `
        <div class="mb-5">
            <h3 class="text-xs font-bold text-orange-500 uppercase tracking-wider mb-2">Подтверждение приемки коробок</h3>
            <div class="space-y-2">
                ${pendingBoxes.map((b) => `
                    <div class="bg-orange-50 p-3 rounded-xl border border-orange-200 flex justify-between items-center">
                        <div>
                            <div class="text-xs text-gray-500">Курьер: ${escapeHtml(state.usersMap[b.courierId]?.name || "Курьер")}</div>
                            <div class="font-bold text-gray-800 text-lg">${b.count} кор.</div>
                        </div>
                        <button onclick="appActions.approveEvent('${escapeHtml(b.id)}', 'boxes', this)" class="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-bold">Принять</button>
                    </div>
                `).join("")}
            </div>
        </div>` : "";

    container.innerHTML = `
        ${pendingBoxesHtml}
        <div class="tg-card bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-md mb-4">
            <div class="text-[10px] text-rose-100 font-semibold uppercase tracking-wider">Текущий долг за коробки (${formatMoney(state.tariffs.boxFulfillmentPriceKopecks)} ₽/шт)</div>
            <div class="text-3xl font-black my-2">${formatMoney(metrics.fulfillmentDebtKopecks)} ₽</div>
            <div class="text-xs text-rose-100 border-t border-rose-400/30 pt-2">Всего коробок принято: <b>${metrics.totalBoxesCountAll} шт</b></div>
            ${metrics.pendingPaymentsKopecks > 0 ? `<div class="mt-2 bg-white/20 rounded-lg p-2 text-xs">Ожидает проверки владельцем: <b>${formatMoney(metrics.pendingPaymentsKopecks)} ₽</b></div>` : ""}
        </div>

        <div class="tg-card border border-green-200 mb-4">
            <h2 class="font-bold text-gray-800 mb-3">Внести оплату долга</h2>
            <div class="flex gap-2">
                <input type="number" step="0.01" id="inputPayment" class="tg-input !mb-0" placeholder="Сумма, ₽" min="0.01">
                <button id="btnPay" class="tg-button !w-auto px-6 bg-green-500 hover:bg-green-600">Отправить</button>
            </div>
        </div>

        <div class="tg-card border border-blue-200">
            <h2 class="font-bold text-gray-800 mb-3">Создать задание на отгрузку</h2>
            <input type="number" id="inputItems" class="tg-input mb-3" placeholder="Количество собранных ШК" min="1" step="1">
            <button id="btnItems" class="tg-button">Опубликовать задание</button>
        </div>

        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mt-6 mb-2">Журнал операций (${escapeHtml(state.selectedMonth)})</h3>
        ${renderHistoryHtml()}
    `;

    document.getElementById("btnItems").onclick = async (e) => {
        const count = Number(document.getElementById("inputItems").value);
        if (!Number.isInteger(count) || count <= 0 || count > 100000) return showToast("Введите целое число ШК от 1 до 100000");
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await Repo.createItemsTask(count, state.user.id, state.tariffs);
            showToast("Задание опубликовано!");
            loadHistory(true);
        } catch (err) { showToast(err.message, true); }
        finally { btn.disabled = false; }
    };

    document.getElementById("btnPay").onclick = async (e) => {
        const kopecks = rubToKopecks(document.getElementById("inputPayment").value);
        if (isNaN(kopecks) || kopecks <= 0) return showToast("Введите корректную сумму");
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await Repo.callSubmitPayment(kopecks);
            showToast("Оплата отправлена на проверку!");
            loadHistory(true);
        } catch (err) { showToast(err.message, true); }
        finally { btn.disabled = false; }
    };
}

function renderCourier(container, metrics) {
    const activeTasks = state.pendingEvents.filter((e) => e.type === "items" && !e.courierId);
    const activeTasksHtml = activeTasks.length ? `
        <div class="mb-5">
            <h3 class="text-xs font-bold text-orange-500 uppercase tracking-wider mb-2">Доступные задания</h3>
            <div class="space-y-2">
                ${activeTasks.map((t) => `
                    <div class="bg-orange-50 p-3 rounded-xl border border-orange-200 flex justify-between items-center">
                        <div>
                            <div class="font-bold text-gray-800 text-lg">Собрано: ${t.count} ШК</div>
                            <div class="text-xs text-gray-500">Тариф: ${formatMoney(t.tariffSnapshot?.itemCourierPayKopecks)} ₽/ШК</div>
                        </div>
                        <button onclick="appActions.claimTask('${escapeHtml(t.id)}', this)" class="bg-orange-500 text-white px-5 py-2 rounded-lg text-sm font-bold">Забрать</button>
                    </div>
                `).join("")}
            </div>
        </div>` : "";

    container.innerHTML = `
        <div class="tg-card bg-gradient-to-br from-green-500 to-emerald-600 text-white shadow-md">
            <div class="flex justify-between items-start mb-1">
                <div class="text-sm opacity-90">Заработано за месяц</div>
                <div class="text-xs font-bold bg-white/20 px-2 py-1 rounded">К выплате: ${formatMoney(metrics.myBalanceKopecks)} ₽</div>
            </div>
            <div class="text-3xl font-bold mb-3">${formatMoney(metrics.myMonthTotalEarnKopecks)} ₽</div>
            <div class="flex justify-between text-sm border-t border-white/20 pt-2">
                <span>Товары: <b>${formatMoney(metrics.myMonthItemsEarnKopecks)} ₽</b></span>
                <span>Коробки: <b>${formatMoney(metrics.myMonthBoxesEarnKopecks)} ₽</b></span>
            </div>
        </div>

        ${activeTasksHtml}

        <div class="tg-card border border-blue-100 mt-4">
            <h3 class="font-bold text-gray-800 mb-3">Сдать коробки (${formatMoney(state.tariffs.boxCourierPayKopecks)} ₽/шт)</h3>
            <div class="flex gap-2">
                <input type="number" id="inputBoxes" class="tg-input !mb-0" placeholder="Кол-во, шт." min="1" step="1">
                <button id="btnBoxes" class="tg-button !w-auto px-6">Сдать</button>
            </div>
        </div>

        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mt-6 mb-2">Журнал операций (${escapeHtml(state.selectedMonth)})</h3>
        ${renderHistoryHtml()}
    `;

    document.getElementById("btnBoxes").onclick = async (e) => {
        const count = Number(document.getElementById("inputBoxes").value);
        if (!Number.isInteger(count) || count <= 0 || count > 10000) return showToast("Введите целое число коробок");
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await Repo.createBoxesSubmission(count, state.user.id, state.tariffs);
            showToast("Коробки отправлены на приемку!");
            loadHistory(true);
        } catch (err) { showToast(err.message, true); }
        finally { btn.disabled = false; }
    };
}

function renderOwner(container, metrics) {
    const tabsHtml = `
        <div class="flex bg-gray-200 p-1 rounded-xl mb-4 gap-1">
            <button onclick="appActions.switchTab('dashboard')" class="flex-1 py-2 text-xs font-bold rounded-lg ${state.ownerTab === "dashboard" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}">📊 Финансы</button>
            <button onclick="appActions.switchTab('team')" class="flex-1 py-2 text-xs font-bold rounded-lg ${state.ownerTab === "team" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}">👥 Команда</button>
            <button onclick="appActions.switchTab('tariffs')" class="flex-1 py-2 text-xs font-bold rounded-lg ${state.ownerTab === "tariffs" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}">⚙️ Тарифы</button>
        </div>`;

    if (state.ownerTab === "team") {
        const usersHtml = Object.values(state.usersMap).map((u) => `
            <div class="bg-white p-3 rounded-xl border border-gray-200 flex justify-between items-center">
                <div>
                    <div class="font-bold text-sm">${escapeHtml(u.name)}</div>
                    <div class="text-xs text-gray-500">ID: ${escapeHtml(maskTgId(u.tg_id))}</div>
                </div>
                <span class="text-xs font-bold px-2.5 py-1 rounded-full bg-gray-100">${escapeHtml(u.role)}</span>
            </div>
        `).join("");

        container.innerHTML = `${tabsHtml}
            <div class="tg-card mb-4">
                <h3 class="text-sm font-bold mb-3">➕ Добавить участника</h3>
                <div class="space-y-2.5">
                    <input type="text" id="newUserName" class="tg-input !p-2.5 text-sm" placeholder="Имя" maxlength="50">
                    <div class="grid grid-cols-2 gap-2">
                        <select id="newUserRole" class="tg-input !p-2.5 text-sm">
                            <option value="courier">Курьер</option>
                            <option value="fulfillment">Фулфилмент</option>
                            <option value="owner">Владелец</option>
                        </select>
                        <input type="text" id="newUserTgId" class="tg-input !p-2.5 text-sm" placeholder="Telegram ID">
                    </div>
                    <button id="btnAddUser" class="tg-button bg-purple-600 py-3 text-sm">Сохранить</button>
                </div>
            </div>
            <div class="space-y-2">${usersHtml}</div>`;

        document.getElementById("btnAddUser").onclick = async () => {
            const name = document.getElementById("newUserName").value.trim();
            const role = document.getElementById("newUserRole").value;
            const tg_id = document.getElementById("newUserTgId").value.trim();
            if (!name || !/^\d{4,15}$/.test(tg_id)) return showToast("Проверьте имя и цифровой Telegram ID");
            if (Object.values(state.usersMap).some((u) => String(u.tg_id) === tg_id)) return showToast("Этот ID уже зарегистрирован");
            try {
                await Repo.addUserDoc({ name, role, tg_id }, state.user.id);
                showToast("Участник добавлен!");
            } catch (e) { showToast(e.message, true); }
        };
        return;
    }

    if (state.ownerTab === "tariffs") {
        const t = state.tariffs;
        container.innerHTML = `${tabsHtml}
            <div class="tg-card space-y-3">
                <h3 class="text-base font-bold">⚙️ Тарифы (действуют только для новых записей)</h3>
                <div>
                    <label class="text-xs font-bold text-gray-600">Коробка для Фулфилмента (₽)</label>
                    <input type="number" step="0.01" id="tBoxFF" value="${formatMoney(t.boxFulfillmentPriceKopecks)}" class="tg-input !p-2.5 text-sm">
                </div>
                <div>
                    <label class="text-xs font-bold text-gray-600">Оплата курьеру за коробку (₽)</label>
                    <input type="number" step="0.01" id="tBoxC" value="${formatMoney(t.boxCourierPayKopecks)}" class="tg-input !p-2.5 text-sm">
                </div>
                <div>
                    <label class="text-xs font-bold text-gray-600">Оплата курьеру за 1 ШК (₽)</label>
                    <input type="number" step="0.01" id="tItemC" value="${formatMoney(t.itemCourierPayKopecks)}" class="tg-input !p-2.5 text-sm">
                </div>
                <div>
                    <label class="text-xs font-bold text-gray-600">Выплата Ozon за 1 ШК (₽)</label>
                    <input type="number" step="0.01" id="tItemOzon" value="${formatMoney(t.itemOzonRevenueKopecks)}" class="tg-input !p-2.5 text-sm">
                </div>
                <button id="btnSaveTariffs" class="tg-button bg-indigo-600 py-3 text-sm">Сохранить тарифы</button>
            </div>`;

        document.getElementById("btnSaveTariffs").onclick = async () => {
            const payload = {
                boxFulfillmentPriceKopecks: rubToKopecks(document.getElementById("tBoxFF").value),
                boxCourierPayKopecks: rubToKopecks(document.getElementById("tBoxC").value),
                itemCourierPayKopecks: rubToKopecks(document.getElementById("tItemC").value),
                itemOzonRevenueKopecks: rubToKopecks(document.getElementById("tItemOzon").value)
            };
            if (Object.values(payload).some((v) => isNaN(v) || v < 0)) return showToast("Некорректные значения");
            try {
                await Repo.saveTariffsDoc(payload, state.user.id);
                showToast("Тарифы обновлены!");
            } catch (e) { showToast(e.message, true); }
        };
        return;
    }

    // Вкладка Финансы
    const pendingPayments = state.pendingEvents.filter((e) => e.type === "payment");
    const pendingHtml = pendingPayments.length ? `
        <div class="tg-card border border-yellow-300 bg-yellow-50 mb-4">
            <h3 class="text-sm font-bold text-yellow-800 mb-2">Оплаты на подтверждение</h3>
            <div class="space-y-2">
                ${pendingPayments.map((p) => `
                    <div class="bg-white p-2.5 rounded-lg border border-yellow-200 flex justify-between items-center">
                        <div>
                            <div class="font-bold text-lg">${formatMoney(p.amountKopecks)} ₽</div>
                            <div class="text-xs text-gray-500">От: ${escapeHtml(state.usersMap[p.authorId]?.name || "Фулфилмент")}</div>
                        </div>
                        <button onclick="appActions.approveEvent('${escapeHtml(p.id)}', 'payment', this)" class="bg-yellow-500 text-white text-xs font-bold px-4 py-2 rounded-lg">Подтвердить</button>
                    </div>
                `).join("")}
            </div>
        </div>` : "";

    const couriers = Object.values(state.usersMap).filter((u) => u.role === "courier");
    const courierOptions = couriers.map((c) => {
        const cMetrics = calculateMetrics(state.approvedEvents, [], [], c.id);
        return `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (Долг: ${formatMoney(cMetrics.myBalanceKopecks)} ₽)</option>`;
    }).join("");

    container.innerHTML = `${tabsHtml}
        ${pendingHtml}
        <div class="tg-card bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-md mb-3">
            <div class="text-[10px] text-indigo-100 font-semibold uppercase">Операционная маржа за месяц</div>
            <div class="text-3xl font-black my-2">${formatMoney(metrics.monthOperatingMarginKopecks)} ₽</div>
            <div class="flex justify-between text-xs border-t border-indigo-400/30 pt-2">
                <span>Ozon: <b>${formatMoney(metrics.monthOzonRevenueKopecks)} ₽</b></span>
                <span>ЗП курьерам: <b>${formatMoney(metrics.monthCourierPayKopecks)} ₽</b></span>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-3 mb-4">
            <div class="bg-white rounded-xl p-3 border border-green-200">
                <div class="text-[10px] text-gray-500 font-bold uppercase">Фулфилмент должен</div>
                <div class="text-xl font-bold text-green-700">${formatMoney(metrics.fulfillmentDebtKopecks)} ₽</div>
            </div>
            <div class="bg-white rounded-xl p-3 border border-red-200">
                <div class="text-[10px] text-gray-500 font-bold uppercase">Мы должны курьерам</div>
                <div class="text-xl font-bold text-red-600">${formatMoney(metrics.totalCourierDebtKopecks)} ₽</div>
            </div>
        </div>

        <div class="tg-card mb-4">
            <h3 class="text-sm font-bold mb-2">Списать выплату курьеру</h3>
            <select id="selectCourier" class="tg-input p-2.5 text-sm mb-2">${courierOptions || '<option value="">Нет курьеров</option>'}</select>
            <div class="flex gap-2">
                <input type="number" step="0.01" id="inputPayout" class="tg-input !mb-0" placeholder="Сумма, ₽" min="0.01">
                <button id="btnPayout" class="tg-button !w-auto px-6">Списать</button>
            </div>
        </div>

        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mt-6 mb-2">Журнал операций (${escapeHtml(state.selectedMonth)})</h3>
        ${renderHistoryHtml()}
    `;

    document.getElementById("btnPayout").onclick = async (e) => {
        const courierId = document.getElementById("selectCourier").value;
        const kopecks = rubToKopecks(document.getElementById("inputPayout").value);
        if (!courierId || isNaN(kopecks) || kopecks <= 0) return showToast("Выберите курьера и укажите сумму");
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await Repo.callSubmitPayout(courierId, kopecks);
            showToast("Выплата списана!");
            loadHistory(true);
        } catch (err) { showToast(err.message, true); }
        finally { btn.disabled = false; }
    };
}

function renderHistoryHtml() {
    if (state.isLoadingHistory && state.monthHistory.length === 0) {
        return `<div class="text-center py-6 text-xs text-gray-400">Загрузка журнала...</div>`;
    }
    if (state.monthHistory.length === 0) {
        return `<div class="text-center py-6 text-sm text-gray-500">Записей за выбранный месяц нет</div>`;
    }

    const rows = state.monthHistory.map((e) => {
        const ts = getTimestampMs(e.createdAt);
        const dateStr = new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        const isCancelled = e.status === "cancelled";
        const canCancel = e.status === "pending" && (e.authorId === state.user.id || state.user.role === "owner");

        let title = "";
        if (e.type === "items") title = `🛍️ Отгрузка: ${e.count} ШК`;
        else if (e.type === "boxes") title = `📦 Коробки: ${e.count} шт.`;
        else if (e.type === "payment") title = `💳 Оплата долга: ${formatMoney(e.amountKopecks)} ₽`;
        else if (e.type === "payout") title = `💸 Выплата ЗП: ${formatMoney(e.amountKopecks)} ₽`;

        const statusBadge = isCancelled
            ? `<span class="text-red-500 font-semibold">Отменено</span>`
            : e.status === "approved"
            ? `<span class="text-green-600">Подтверждено</span>`
            : `<span class="text-orange-500">Ожидает</span>`;

        return `
            <div class="bg-white p-3 rounded-xl border border-gray-200 flex justify-between items-center text-sm ${isCancelled ? "opacity-50" : ""}">
                <div>
                    <div class="font-bold text-gray-800 ${isCancelled ? "line-through" : ""}">${title}</div>
                    <div class="text-[11px] text-gray-500 mt-0.5">${statusBadge} • ${dateStr}</div>
                </div>
                ${canCancel ? `<button onclick="appActions.cancelEvent('${escapeHtml(e.id)}', this)" class="text-xs text-red-600 font-semibold px-2 py-1 rounded bg-red-50">Отменить</button>` : ""}
            </div>`;
    }).join("");

    const moreBtn = state.historyCursor
        ? `<button onclick="appActions.loadMore()" class="w-full py-2.5 mt-2 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-600">Загрузить еще</button>`
        : "";

    return `<div class="space-y-2">${rows}${moreBtn}</div>`;
}

bootstrap();