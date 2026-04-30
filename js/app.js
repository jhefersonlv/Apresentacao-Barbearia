'use strict';

// ─── CONFIG (localStorage) ────────────────────────────────────────────────────

const CONFIG_KEY = 'barberpro_site_config';

function loadConfig() {
  try {
    return Object.assign(
      { businessName: '', apiUrl: '', apiKey: '', apiSecret: '', whatsapp: '' },
      JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')
    );
  } catch (_) {
    return { businessName: '', apiUrl: '', apiKey: '', apiSecret: '', whatsapp: '' };
  }
}

function persistConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

let API_URL    = '';
let API_KEY    = '';
let API_SECRET = '';
let WHATSAPP   = '';

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  services:   [],
  categories: [],
  employees:  [],

  step: 3,

  // Seleções temporárias do item atual
  tempServicos:    [],
  tempFuncionario: null,
  tempData:        null,
  tempHora:        null,
  tempCategoriaId: null,

  // ── CARRINHO MULTI-SERVIÇO ──────────────────────────────────────────────
  // Cada item: { servicos[], funcionarioId, funcionarioNome, data, hora }
  carrinho: [],

  // Indica se o fluxo começou com serviço pré-selecionado (step 3)
  // ou no início (step 1 → categoria)
  flowStartStep: 3,

  // Calendário
  weekStart:    null,
  allSlots:     [],
  availSlots:   [],
  slotsLoading: false,

  // Dados do cliente
  clienteNome:     '',
  clienteTelefone: '',
  clienteEmail:    '',
  clienteObs:      '',
  sessionId:       '',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const DAY_SHORT   = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_NAMES = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDate(date) { return date.toISOString().split('T')[0]; }

function fmtCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(parseFloat(value || 0));
}

function generateAllSlots(emp, dayOfWeek, durationMin) {
  if (!emp?.workingHours?.workingDays) return [];
  const wd = emp.workingHours.workingDays.find(d => d.dayOfWeek === dayOfWeek);
  if (!wd || !wd.isWorkingDay || !wd.timeSlots?.length) return [];
  const slots = [];
  for (const ts of wd.timeSlots) {
    const [sh, sm] = ts.startTime.split(':').map(Number);
    const [eh, em] = ts.endTime.split(':').map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    for (let t = start; t + durationMin <= end; t += 30) {
      const s  = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      const e2 = t + durationMin;
      const en = `${String(Math.floor(e2 / 60)).padStart(2, '0')}:${String(e2 % 60).padStart(2, '0')}`;
      slots.push({ startTime: s, endTime: en });
    }
  }
  return slots;
}

function getTotalDuration() {
  return state.tempServicos.reduce((sum, id) => {
    const s = state.services.find(s => s.id === id);
    return sum + (s?.durationMinutes || 60);
  }, 0) || 60;
}

function getPriceByIds(ids) {
  return ids.reduce((sum, id) => {
    const s = state.services.find(s => s.id === id);
    return sum + parseFloat(s?.unitPrice || 0);
  }, 0);
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function apiCall(endpoint, options = {}) {
  if (!API_URL || !API_KEY) throw new Error('Configure a integração nas Configurações ⚙️');
  const resp = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key':    API_KEY,
      'X-API-Secret': API_SECRET,
      ...(options.headers || {}),
    },
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  if (!resp.ok) {
    const msg = data.message || data.error || data.errors?.[0]?.message || `Erro HTTP ${resp.status}`;
    console.error('[BarberPro] API error', resp.status, endpoint, data);
    throw new Error(msg);
  }
  return data;
}

// ─── TOAST ───────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} toast-show`;
  setTimeout(() => { el.className = 'toast'; }, 3500);
}

// ─── CATEGORIAS ───────────────────────────────────────────────────────────────
function extractCategories(services) {
  const map = new Map();
  services.forEach(svc => {
    if (svc.categories?.length) {
      svc.categories.forEach(cat => {
        const key = String(cat.id);
        if (!map.has(key)) map.set(key, { id: key, name: cat.name });
      });
    } else if (svc.category) {
      const key = String(svc.category);
      if (!map.has(key)) map.set(key, { id: key, name: svc.category });
    }
  });
  return Array.from(map.values());
}

function getServicesInCategory(catId) {
  return state.services.filter(s => {
    if (s.isActive === false) return false;
    if (s.categories?.length) return s.categories.some(c => String(c.id) === catId);
    return String(s.category) === catId;
  });
}

// ─── SEÇÃO DE SERVIÇOS DO SITE ────────────────────────────────────────────────
function renderSiteServices() {
  const filterEl = document.getElementById('site-services-filter');
  const gridEl   = document.getElementById('site-services-grid');
  if (!gridEl) return;

  const active = state.services.filter(s => s.isActive !== false);
  if (!active.length) {
    gridEl.innerHTML = '<p style="text-align:center;color:#555;padding:40px">Nenhum serviço encontrado</p>';
    return;
  }

  let activeCat = '';

  function renderFilter() {
    if (!filterEl) return;
    const cats = state.categories;
    filterEl.innerHTML = cats.length ? `
      <div class="svc-cat-tabs">
        <button class="svc-cat-tab${activeCat === '' ? ' active' : ''}" data-cat="">Todos</button>
        ${cats.map(c => `
          <button class="svc-cat-tab${activeCat === c.id ? ' active' : ''}" data-cat="${c.id}">${c.name}</button>
        `).join('')}
      </div>` : '';
    filterEl.querySelectorAll('.svc-cat-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCat = btn.dataset.cat;
        renderFilter();
        renderCards();
      });
    });
  }

  function renderCards() {
    const filtered = activeCat
      ? active.filter(s =>
          s.categories?.some(c => String(c.id) === activeCat) ||
          String(s.category) === activeCat
        )
      : active;

    gridEl.innerHTML = `<div class="svc-grid-main">${filtered.map(s => `
      <div class="svc-card">
        <div class="svc-card-photo">
          ${s.imageUrl
            ? `<img class="svc-img" src="${s.imageUrl}" alt="${s.name}">`
            : `<div class="svc-card-photo-placeholder">
                 <svg width="48" height="48" viewBox="0 0 24 24" fill="var(--gold)">
                   <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64z"/>
                 </svg>
               </div>`
          }
          <div class="svc-card-price-badge">${fmtCurrency(s.unitPrice)}</div>
        </div>
        <div class="svc-card-body">
          <div class="svc-card-name">${s.name}</div>
          ${s.details ? `<p class="svc-card-desc">${s.details}</p>` : '<p class="svc-card-desc"></p>'}
          <div class="svc-card-footer">
            <span class="svc-card-duration">⏱ ${s.durationMinutes || 60} min</span>
            <button class="svc-card-book btn-agendar-site" data-service-id="${s.id}">Agendar →</button>
          </div>
        </div>
      </div>`).join('')}
    </div>`;

    gridEl.querySelectorAll('.btn-agendar-site').forEach(btn => {
      btn.addEventListener('click', () => openBookingModal(btn.dataset.serviceId));
    });
  }

  renderFilter();
  renderCards();
}

function renderSiteTeam() {
  const container = document.getElementById('site-team-grid');
  if (!container) return;
  if (!state.employees.length) {
    container.innerHTML = '<p style="text-align:center;color:#555;padding:40px">Equipe não disponível</p>';
    return;
  }
  const colors = ['#2a1f0a', '#0a1a2a', '#1a0a2a', '#0a2a1a', '#2a0a1a'];
  container.innerHTML = state.employees.map((emp, idx) => {
    const inits     = (emp.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const position  = emp.position?.name || emp.position || '';
    const avatarUrl = emp.avatarUrl || emp.user?.avatarUrl || null;
    const bg        = colors[idx % colors.length];
    return `
      <div style="border:1px solid #1e1e1e;border-radius:4px;overflow:hidden;transition:border-color .3s"
           onmouseenter="this.style.borderColor='var(--gold-dark)'"
           onmouseleave="this.style.borderColor='#1e1e1e'">
        <div style="aspect-ratio:3/4;background:${bg};display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
          ${avatarUrl
            ? `<img src="${avatarUrl}" alt="${emp.name}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0">`
            : `<span style="font-family:'Playfair Display';font-size:52px;font-weight:700;color:rgba(201,168,76,.3)">${inits}</span>`
          }
          ${idx === 0 ? `<div style="position:absolute;top:12px;right:12px;background:var(--gold);color:var(--black);font-size:9px;font-weight:700;padding:4px 8px;letter-spacing:.1em;text-transform:uppercase">${position}</div>` : ''}
        </div>
        <div style="padding:20px 20px 24px">
          <div style="font-family:'Playfair Display';font-size:18px;font-weight:600;margin-bottom:4px">${emp.name}</div>
          <div style="font-size:12px;color:var(--gold);margin-bottom:10px;font-weight:500">${position}</div>
          <button class="btn-equipe-agendar" style="width:100%;background:none;border:1px solid #2a2a2a;color:#888;padding:9px;font-size:12px;cursor:pointer;border-radius:2px;font-family:Outfit;font-weight:500;transition:all .2s"
            onmouseenter="this.style.borderColor='var(--gold)';this.style.color='var(--gold)'"
            onmouseleave="this.style.borderColor='#2a2a2a';this.style.color='#888'">
            Agendar com ${(emp.name || '').split(' ')[0]}
          </button>
        </div>
      </div>`;
  }).join('');
  container.querySelectorAll('.btn-equipe-agendar').forEach(btn => {
    btn.addEventListener('click', () =>
      document.getElementById('servicos')?.scrollIntoView({ behavior: 'smooth' })
    );
  });
}

// ─── BOOKING MODAL — ABERTURA ─────────────────────────────────────────────────

function openBookingModal(serviceId) {
  if (!API_URL || !API_KEY) {
    showToast('Configure a integração antes de agendar ⚙️', 'error');
    openConfigModal();
    return;
  }
  const _now = new Date();
  state.weekStart = new Date(_now.getFullYear(), _now.getMonth(), 1);
  state.sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.carrinho  = [];
  clearTempSelections();

  document.getElementById('booking-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  if (serviceId) {
    // Serviço pré-selecionado → pula steps 1 e 2
    state.tempServicos    = [serviceId];
    state.tempCategoriaId = null;
    state.flowStartStep   = 3;
    goToStep(3);
  } else {
    // Fluxo completo → começa na categoria
    state.tempCategoriaId = null;
    state.flowStartStep   = 1;
    goToStep(1);
  }
}

function closeBookingModal() {
  document.getElementById('booking-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function clearTempSelections() {
  state.tempServicos    = [];
  state.tempFuncionario = null;
  state.tempData        = null;
  state.tempHora        = null;
  state.allSlots        = [];
  state.availSlots      = [];
}

function resetFullBooking() {
  state.carrinho = [];
  clearTempSelections();
  state.clienteNome     = '';
  state.clienteTelefone = '';
  state.clienteEmail    = '';
  state.clienteObs      = '';
}

// ─── CARRINHO ─────────────────────────────────────────────────────────────────

function addCurrentToCart() {
  state.carrinho.push({
    servicos:        [...state.tempServicos],
    funcionarioId:   state.tempFuncionario.id,
    funcionarioNome: state.tempFuncionario.name,
    data:            state.tempData,
    hora:            state.tempHora,
  });
}

function renderCarrinhoResumo() {
  const container = document.getElementById('carrinho-resumo');
  const lista     = document.getElementById('carrinho-lista');
  if (!container || !lista) return;
  if (!state.carrinho.length) { container.style.display = 'none'; return; }
  container.style.display = 'block';
  lista.innerHTML = state.carrinho.map((item, i) => {
    const svcs      = item.servicos.map(id => state.services.find(s => s.id === id)).filter(Boolean);
    const itemTotal = getPriceByIds(item.servicos);
    return `
      <div class="cart-item">
        <div class="cart-item-num">${i + 1}</div>
        <div class="cart-item-info">
          <div class="cart-item-svcs">${svcs.map(s => s.name).join(' + ')}</div>
          <div class="cart-item-meta">${item.funcionarioNome} · ${item.data} ${item.hora}</div>
        </div>
        <div class="cart-item-price">${fmtCurrency(itemTotal)}</div>
      </div>`;
  }).join('');
}

// ─── NAVEGAÇÃO DE STEPS ───────────────────────────────────────────────────────

function goToStep(n) {
  state.step = n;
  document.querySelectorAll('.step-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById(`step-${n}`);
  if (panel) panel.style.display = 'block';

  renderStepIndicator();

  if      (n === 1) renderStep1();
  else if (n === 2) renderStep2();
  else if (n === 3) renderStep3();
  else if (n === 4) renderStep4();
  else if (n === 5) renderStep5();
  else if (n === 6) renderStep6();
  else if (n === 7) renderStep7();

  updateModalFooter();
}

// Steps visíveis no indicador
const STEP_VISUAL_FULL = [
  { step: 1, label: 'Categoria'    },
  { step: 2, label: 'Serviço'      },
  { step: 3, label: 'Profissional' },
  { step: 4, label: 'Horário'      },
  { step: 6, label: 'Seus dados'   },
  { step: 7, label: 'Confirmar'    },
];

const STEP_VISUAL_SHORT = [
  { step: 3, label: 'Profissional' },
  { step: 4, label: 'Horário'      },
  { step: 6, label: 'Seus dados'   },
  { step: 7, label: 'Confirmar'    },
];

function renderStepIndicator() {
  const container = document.getElementById('step-indicator');
  if (!container) return;

  const steps = state.flowStartStep === 1 ? STEP_VISUAL_FULL : STEP_VISUAL_SHORT;
  const cur   = state.step;

  container.innerHTML = steps.map((item, i) => {
    const done   = cur > item.step;
    const active = cur === item.step;
    const after  = i < steps.length - 1;
    return `
      <div class="si-item">
        <div class="si-dot${done ? ' done' : active ? ' active' : ''}">${done ? '✓' : i + 1}</div>
        <div class="si-label${active ? ' active' : ''}">${item.label}</div>
        ${after ? `<div class="si-line${done ? ' done' : ''}"></div>` : ''}
      </div>`;
  }).join('');
}

function updateModalFooter() {
  const btnVoltar    = document.getElementById('btn-voltar');
  const btnContinuar = document.getElementById('btn-continuar');
  const btnConfirmar = document.getElementById('btn-confirmar');
  btnVoltar.style.display    = 'none';
  btnContinuar.style.display = 'none';
  btnConfirmar.style.display = 'none';
  const { step } = state;

  if (step === 7) {
    btnVoltar.style.display    = 'inline-flex';
    btnConfirmar.style.display = 'inline-flex';
    return;
  }

  // Step 5 (decisão): só mostra Voltar — os botões de ação estão no corpo
  if (step === 5) {
    btnVoltar.style.display = 'inline-flex';
    return;
  }

  // Mostra Voltar exceto no primeiro step do fluxo atual
  const firstStep = state.flowStartStep === 1 ? 1 : 3;
  if (step !== firstStep) btnVoltar.style.display = 'inline-flex';

  btnContinuar.style.display = 'inline-flex';
  btnContinuar.disabled      = !canAdvance();
  btnContinuar.style.opacity = canAdvance() ? '1' : '0.45';
  btnContinuar.style.cursor  = canAdvance() ? 'pointer' : 'not-allowed';
}

function canAdvance() {
  const { step, tempFuncionario, tempData, tempHora, tempCategoriaId, tempServicos, clienteNome, clienteTelefone } = state;
  if (step === 1) return !!tempCategoriaId;
  if (step === 2) return tempServicos.length > 0;
  if (step === 3) return !!tempFuncionario;
  if (step === 4) return !!(tempData && tempHora);
  if (step === 6) return clienteNome.trim().length > 1 && clienteTelefone.replace(/\D/g, '').length >= 10;
  return false;
}

function handleContinuar() {
  if (!canAdvance()) return;
  const { step } = state;
  if      (step === 1) goToStep(2);
  else if (step === 2) goToStep(3);
  else if (step === 3) goToStep(4);
  else if (step === 4) goToStep(5); // Após escolher data/hora → decisão do carrinho
  else if (step === 6) goToStep(7);
}

function handleVoltar() {
  const { step } = state;
  if (step === 1) {
    closeBookingModal();
  } else if (step === 2) {
    state.tempCategoriaId = null;
    state.tempServicos    = [];
    goToStep(1);
  } else if (step === 3) {
    if (state.tempCategoriaId) {
      goToStep(2); // Veio do fluxo de categoria
    } else {
      closeBookingModal(); // Serviço pré-selecionado: fecha modal
    }
  } else if (step === 4) {
    state.tempData    = null;
    state.tempHora    = null;
    state.allSlots    = [];
    state.availSlots  = [];
    goToStep(3);
  } else if (step === 5) {
    // Volta ao calendário sem limpar a seleção
    goToStep(4);
  } else if (step === 6) {
    goToStep(4);
  } else if (step === 7) {
    goToStep(6);
  }
}

// ─── STEP 1: CATEGORIAS ───────────────────────────────────────────────────────

function renderStep1() {
  const container = document.getElementById('step-1-content');
  if (!container) return;
  if (!state.categories.length) {
    container.innerHTML = '<div class="modal-spinner-wrap"><div class="spinner"></div><p style="color:#555;margin-top:12px">Carregando categorias...</p></div>';
    return;
  }
  container.innerHTML = `
    <p class="modal-section-label">Escolha uma categoria de serviço</p>
    <div class="cat-grid">
      ${state.categories.map(cat => {
        const count = getServicesInCategory(cat.id).length;
        const sel   = state.tempCategoriaId === cat.id;
        return `
          <button class="cat-card${sel ? ' selected' : ''}" data-id="${cat.id}">
            <div class="cat-card-name">${cat.name}</div>
            <div class="cat-card-count">${count} serviço${count !== 1 ? 's' : ''}</div>
          </button>`;
      }).join('')}
    </div>`;
  container.querySelectorAll('.cat-card').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tempCategoriaId = btn.dataset.id;
      state.tempServicos    = [];
      updateModalFooter();
      setTimeout(() => handleContinuar(), 220);
    });
  });
}

// ─── STEP 2: SERVIÇOS ─────────────────────────────────────────────────────────

function renderStep2() {
  const container = document.getElementById('step-2-content');
  if (!container) return;
  const filtered = getServicesInCategory(state.tempCategoriaId);
  const cat      = state.categories.find(c => c.id === state.tempCategoriaId);
  if (!filtered.length) {
    container.innerHTML = '<p class="modal-empty">Nenhum serviço nesta categoria</p>';
    return;
  }
  container.innerHTML = `
    <p class="modal-section-label">${cat?.name || 'Serviços'} — toque para selecionar</p>
    <div class="svc-modal-list">
      ${filtered.map(s => {
        const sel = state.tempServicos[0] === s.id;
        return `
          <div class="svc-modal-card${sel ? ' selected' : ''}" data-id="${s.id}">
            ${s.imageUrl
              ? `<img src="${s.imageUrl}" alt="${s.name}" class="svc-modal-img" onerror="this.style.display='none'">`
              : '<div class="svc-modal-img-placeholder"></div>'
            }
            <div class="svc-modal-info">
              <div class="svc-modal-name">${s.name}</div>
              ${s.details ? `<div class="svc-modal-desc">${s.details}</div>` : ''}
              <div class="svc-modal-dur">⏱ ${s.durationMinutes || 60} min</div>
            </div>
            <div class="svc-modal-right">
              <div class="svc-modal-price">${fmtCurrency(s.unitPrice)}</div>
              <div class="svc-check-circle${sel ? ' checked' : ''}">${sel ? '✓' : ''}</div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
  container.querySelectorAll('.svc-modal-card').forEach(card => {
    card.addEventListener('click', () => {
      state.tempServicos = [card.dataset.id];
      updateModalFooter();
      setTimeout(() => handleContinuar(), 220);
    });
  });
}

// ─── STEP 3: FUNCIONÁRIOS ─────────────────────────────────────────────────────

function employeeCanDoService(emp, serviceIds) {
  if (!serviceIds?.length) return true;
  if (!emp.services?.length) return true;
  const empSet = new Set(emp.services.map(s => s.id));
  return serviceIds.every(id => empSet.has(id));
}

function renderStep3() {
  const container = document.getElementById('step-3-content');
  if (!container) return;
  if (!state.employees.length) {
    container.innerHTML = '<div class="modal-spinner-wrap"><div class="spinner"></div></div>';
    return;
  }
  const eligible = state.employees.filter(emp => employeeCanDoService(emp, state.tempServicos));
  const svc      = state.services.find(s => s.id === state.tempServicos[0]);
  const svcBadge = svc ? `
    <div class="svc-selection-badge">
      Serviço selecionado: <strong>${svc.name}</strong> &nbsp;·&nbsp;
      ${fmtCurrency(svc.unitPrice)} &nbsp;·&nbsp; ⏱ ${svc.durationMinutes || 60} min
    </div>` : '';

  if (!eligible.length) {
    container.innerHTML = `${svcBadge}<p class="modal-empty">Nenhum profissional disponível para este serviço.</p>`;
    return;
  }
  container.innerHTML = `
    ${svcBadge}
    <p class="modal-section-label">Escolha o profissional</p>
    <div class="emp-list">
      ${eligible.map(emp => {
        const position  = emp.position?.name || emp.position || '';
        const avatarUrl = emp.avatarUrl || emp.user?.avatarUrl || null;
        const inits     = (emp.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const isSel     = state.tempFuncionario?.id === emp.id;
        return `
          <div class="emp-item${isSel ? ' selected' : ''}" data-id="${emp.id}">
            <div class="emp-item-avatar-wrap">
              ${avatarUrl
                ? `<img src="${avatarUrl}" alt="${emp.name}" class="emp-item-avatar"
                       onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                : ''
              }
              <div class="emp-item-initials"${avatarUrl ? ' style="display:none"' : ''}>${inits}</div>
            </div>
            <div class="emp-item-info">
              <div class="emp-item-name">${emp.name}</div>
              ${position ? `<div class="emp-item-position">${position}</div>` : ''}
            </div>
            <div class="emp-item-check">${isSel ? '✓' : ''}</div>
          </div>`;
      }).join('')}
    </div>`;
  container.querySelectorAll('.emp-item').forEach(item => {
    item.addEventListener('click', () => {
      state.tempFuncionario = state.employees.find(e => e.id === item.dataset.id);
      state.tempHora        = null;
      state.allSlots        = [];
      state.availSlots      = [];
      renderStep3();
      setTimeout(() => handleContinuar(), 220);
      updateModalFooter();
    });
  });
}

// ─── STEP 4: DATA + HORA ─────────────────────────────────────────────────────

function renderStep4() {
  const container = document.getElementById('step-4-content');
  if (!container) return;

  const year      = state.weekStart.getFullYear();
  const month     = state.weekStart.getMonth();
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const firstDay  = new Date(year, month, 1);
  const lastDay   = new Date(year, month + 1, 0);
  const startDow  = firstDay.getDay();
  const totalDays = lastDay.getDate();

  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell cal-empty"></div>';
  for (let d = 1; d <= totalDays; d++) {
    const date    = new Date(year, month, d);
    const dateStr = fmtDate(date);
    const isPast  = date < today;
    const isToday = dateStr === fmtDate(today);
    const isSel   = state.tempData === dateStr;
    cells += `<button class="cal-cell cal-day${isPast ? ' cal-past' : ''}${isToday ? ' cal-today' : ''}${isSel ? ' cal-selected' : ''}"
      data-date="${dateStr}" ${isPast ? 'disabled' : ''}>${d}</button>`;
  }

  container.innerHTML = `
    <p class="modal-section-label">Escolha o dia</p>
    <div class="cal-wrap">
      <div class="cal-header">
        <button class="cal-nav-btn" id="prev-month-btn">←</button>
        <span class="cal-month-label">${MONTH_NAMES[month]} ${year}</span>
        <button class="cal-nav-btn" id="next-month-btn">→</button>
      </div>
      <div class="cal-weekdays">${DAY_SHORT.map(d => `<div class="cal-weekday">${d}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </div>
    <div id="slots-section" style="display:${state.tempData ? 'block' : 'none'}">
      <p class="modal-section-label" style="margin-top:24px">
        Horários disponíveis — ${state.tempFuncionario?.name || ''}
      </p>
      <div id="slots-list">
        ${state.slotsLoading
          ? '<div class="modal-spinner-wrap"><div class="spinner"></div></div>'
          : buildSlotsHTML()
        }
      </div>
    </div>`;

  container.querySelectorAll('.cal-day:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => handleDateSelect(btn.dataset.date));
  });
  document.getElementById('prev-month-btn').addEventListener('click', () => navMonth(-1));
  document.getElementById('next-month-btn').addEventListener('click', () => navMonth(1));
  bindSlotButtons();
}

function buildSlotsHTML() {
  if (!state.tempData) return '';
  function slotBtn(slot, avail) {
    const isSel = state.tempHora === slot.startTime;
    const cls   = `slot-btn${isSel ? ' selected' : ''}${!avail ? ' occupied' : ''}`;
    return `<button class="${cls}" data-start="${slot.startTime}" data-end="${slot.endTime}"
              ${!avail ? 'disabled title="Horário ocupado"' : ''}>${slot.startTime}</button>`;
  }
  if (state.allSlots.length) {
    const availSet = new Set(state.availSlots.map(s => s.startTime));
    return `<div class="slots-grid">${state.allSlots.map(slot => slotBtn(slot, availSet.has(slot.startTime))).join('')}</div>`;
  }
  if (state.availSlots.length) {
    return `<div class="slots-grid">${state.availSlots.map(slot => slotBtn(slot, true)).join('')}</div>`;
  }
  return '<p class="modal-empty">Nenhum horário disponível para este dia</p>';
}

function bindSlotButtons() {
  document.querySelectorAll('#slots-list .slot-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tempHora = btn.dataset.start;
      document.querySelectorAll('#slots-list .slot-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      updateModalFooter();
    });
  });
}

async function handleDateSelect(dateStr) {
  state.tempData     = dateStr;
  state.tempHora     = null;
  state.allSlots     = [];
  state.availSlots   = [];
  state.slotsLoading = true;
  renderStep4();
  try {
    const d             = new Date(dateStr + 'T12:00:00');
    const totalDuration = getTotalDuration();
    state.allSlots      = generateAllSlots(state.tempFuncionario, d.getDay(), totalDuration);
    const svcIds        = state.tempServicos.join(',');
    const data          = await apiCall(
      `/external/v1/booking/slots?employeeId=${state.tempFuncionario.id}&date=${dateStr}&serviceIds=${svcIds}`
    );
    state.availSlots = data.availableSlots || [];
  } catch (err) {
    showToast('Erro ao carregar horários: ' + err.message, 'error');
  } finally {
    state.slotsLoading = false;
  }
  const slotsList    = document.getElementById('slots-list');
  const slotsSection = document.getElementById('slots-section');
  if (slotsList)    slotsList.innerHTML        = buildSlotsHTML();
  if (slotsSection) slotsSection.style.display = 'block';
  bindSlotButtons();
  updateModalFooter();
}

function navMonth(dir) {
  const ns = new Date(state.weekStart);
  ns.setMonth(ns.getMonth() + dir);
  const today    = new Date();
  const minMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  if (ns >= minMonth) { state.weekStart = ns; renderStep4(); }
}

// ─── STEP 5: DECISÃO DO CARRINHO ─────────────────────────────────────────────

function renderStep5() {
  const preview = document.getElementById('step5-preview');
  if (!preview) return;
  const emp  = state.tempFuncionario;
  const svcs = state.tempServicos.map(id => state.services.find(s => s.id === id)).filter(Boolean);
  const tot  = getPriceByIds(state.tempServicos);
  preview.innerHTML = `
    <div class="decision-preview-card">
      <div class="dp-services">${svcs.map(s => s.name).join(' + ')}</div>
      <div class="dp-meta">
        com <strong>${emp?.name || ''}</strong> ·
        ${state.tempData} às <strong style="color:var(--gold)">${state.tempHora}</strong>
      </div>
      <div class="dp-price">${fmtCurrency(tot)}</div>
    </div>`;
}

function handleDecisionSim() {
  addCurrentToCart();
  const dataAnterior = state.tempData;
  clearTempSelections();
  state.tempData = dataAnterior; // Mantém a data do item anterior como sugestão
  renderCarrinhoResumo();
  if (state.flowStartStep === 1) {
    goToStep(1); // Volta para categoria para novo serviço
  } else {
    // Serviço foi pré-selecionado; volta ao step de profissional
    state.tempCategoriaId = null;
    goToStep(3);
  }
}

function handleDecisionNao() {
  goToStep(6);
}

// ─── STEP 6: DADOS DO CLIENTE ────────────────────────────────────────────────

function maskPhone(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2)  return digits.replace(/(\d{0,2})/, '($1');
  if (digits.length <= 6)  return digits.replace(/(\d{2})(\d{0,4})/, '($1) $2');
  if (digits.length <= 10) return digits.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
  return digits.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
}

function renderStep6() {
  const nomeInput  = document.getElementById('cliente-nome');
  const foneInput  = document.getElementById('cliente-telefone');
  const emailInput = document.getElementById('cliente-email');
  if (!nomeInput || !foneInput) return;
  nomeInput.value  = state.clienteNome;
  foneInput.value  = state.clienteTelefone;
  if (emailInput) emailInput.value = state.clienteEmail;

  const nome2 = nomeInput.cloneNode(true);
  const fone2 = foneInput.cloneNode(true);
  nomeInput.replaceWith(nome2);
  foneInput.replaceWith(fone2);

  nome2.addEventListener('input', () => { state.clienteNome = nome2.value; updateModalFooter(); });
  fone2.addEventListener('input', () => {
    const masked = maskPhone(fone2.value);
    fone2.value = masked;
    state.clienteTelefone = masked;
    updateModalFooter();
  });
  if (emailInput) {
    const email2 = emailInput.cloneNode(true);
    emailInput.replaceWith(email2);
    email2.addEventListener('input', () => { state.clienteEmail = email2.value; });
  }
  const obsInput = document.getElementById('cliente-obs');
  if (obsInput) {
    obsInput.value = state.clienteObs;
    const obs2 = obsInput.cloneNode(true);
    obsInput.replaceWith(obs2);
    obs2.addEventListener('input', () => { state.clienteObs = obs2.value; });
  }
}

// ─── STEP 7: CONFIRMAÇÃO ─────────────────────────────────────────────────────

function getAllBookingItems() {
  const items = [...state.carrinho];
  if (state.tempServicos.length && state.tempFuncionario && state.tempData && state.tempHora) {
    items.push({
      servicos:        [...state.tempServicos],
      funcionarioId:   state.tempFuncionario.id,
      funcionarioNome: state.tempFuncionario.name,
      data:            state.tempData,
      hora:            state.tempHora,
    });
  }
  return items;
}

function renderStep7() {
  const container = document.getElementById('step-7-content');
  if (!container) return;
  const allItems = getAllBookingItems();
  if (!allItems.length) {
    container.innerHTML = '<p class="modal-empty">Nenhum item para confirmar.</p>';
    return;
  }

  const multi = allItems.length > 1;
  let html = `
    <p class="modal-section-label">Revise e confirme seu agendamento</p>
    <div class="confirm-client-box">
      <div class="confirm-row"><span>Nome</span><strong>${state.clienteNome}</strong></div>
      <div class="confirm-row"><span>WhatsApp</span><strong>${state.clienteTelefone}</strong></div>
    </div>`;

  allItems.forEach((item, i) => {
    const svcs     = item.servicos.map(id => state.services.find(s => s.id === id)).filter(Boolean);
    const subtotal = getPriceByIds(item.servicos);
    const isLast   = i === allItems.length - 1;

    html += `<div class="confirm-item-box">
      <div class="confirm-item-header">
        <span>${multi ? `Serviço ${i + 1} · ` : ''}${item.funcionarioNome}</span>
        ${multi
          ? (isLast
              ? '<span class="confirm-current-badge">Novo</span>'
              : `<button class="confirm-remove-btn" data-idx="${i}">Remover</button>`
            )
          : ''
        }
      </div>
      <div class="confirm-row"><span>Data &amp; Hora</span><span>${item.data} às ${item.hora}</span></div>
      ${svcs.map(s => `
        <div class="confirm-row svc-row">
          <span>${s.name}</span><span>${fmtCurrency(s.unitPrice)}</span>
        </div>`).join('')}
      <div class="confirm-row subtotal-row">
        <span>${multi ? 'Subtotal' : 'Total'}</span><strong>${fmtCurrency(subtotal)}</strong>
      </div>
    </div>`;
  });

  if (multi) {
    const grand = allItems.reduce((sum, item) => sum + getPriceByIds(item.servicos), 0);
    html += `<div class="confirm-grand-total"><span>Total Geral</span><strong>${fmtCurrency(grand)}</strong></div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.confirm-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.carrinho.splice(parseInt(btn.dataset.idx), 1);
      renderCarrinhoResumo();
      renderStep7();
    });
  });
}

// ─── CONFIRMAR (POST) ─────────────────────────────────────────────────────────

async function handleConfirmar() {
  const btn = document.getElementById('btn-confirmar');
  btn.disabled    = true;
  btn.textContent = 'Aguardando...';
  try {
    const results  = [];
    const phone    = state.clienteTelefone.replace(/\D/g, '') || undefined;
    const emailRaw = state.clienteEmail.trim();
    const obs      = state.clienteObs.trim() || undefined;
    for (const item of getAllBookingItems()) {
      const emailSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const email       = emailRaw || `bk.${emailSuffix}@agendamento.com.br`;
      const payload = {
        employeeId:    item.funcionarioId,
        date:          item.data,
        time:          item.hora,
        serviceIds:    item.servicos,
        customerName:  state.clienteNome.trim(),
        customerEmail: email,
        customerPhone: phone,
        observation:   obs,
        createOrder:   false,
      };
      const result = await apiCall('/external/v1/booking', { method: 'POST', body: JSON.stringify(payload) });
      results.push(result);
    }
    showSuccessScreen(results);
  } catch (err) {
    showToast('Erro ao confirmar: ' + err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Confirmar Agendamento';
  }
}

function showSuccessScreen(results) {
  document.querySelectorAll('.step-panel').forEach(p => p.style.display = 'none');
  document.getElementById('step-success').style.display = 'block';
  document.getElementById('btn-confirmar').style.display = 'none';
  document.getElementById('btn-voltar').style.display    = 'none';
  const details = document.getElementById('success-details');
  details.innerHTML = results.map((r, i) => `
    <div class="success-item">
      <div>Agendamento ${results.length > 1 ? i + 1 + ' — ' : ''}${r.employeeName || ''}</div>
      ${r.scheduledAt
        ? `<div style="color:var(--gold);font-weight:600">${r.scheduledAt.slice(0, 10)} às ${r.scheduledAt.slice(11, 16)}</div>`
        : ''}
    </div>`).join('');
  const storeCta = document.getElementById('success-store-cta');
  if (storeCta) storeCta.style.display = 'flex';
}

// ─── TESTIMONIALS ─────────────────────────────────────────────────────────────

const TESTIMONIALS = [
  { name: 'Ricardo Alves',  text: 'Serviço impecável! O profissional foi muito atencioso e o resultado ficou exatamente como eu queria. Com certeza voltarei!', stars: 5 },
  { name: 'Marcos Santos',  text: 'Ambiente moderno e aconchegante. Atendimento de primeira, cada detalhe foi cuidado com muito profissionalismo.', stars: 5 },
  { name: 'Felipe Oliveira',text: 'Melhor barbearia da região! Corte e barba perfeitos. Os profissionais são especialistas no que fazem.', stars: 5 },
  { name: 'Bruno Costa',    text: 'Fui indicado por um amigo e não me arrependi. Atendimento excelente, resultado surpreendente. Super recomendo!', stars: 5 },
  { name: 'André Lima',     text: 'Visagismo impecável. O profissional entendeu exatamente o que eu queria e entregou um resultado fantástico.', stars: 5 },
  { name: 'Carlos Mendes',  text: 'Desde que conheci esta barbearia, não troco mais. Qualidade, higiene e profissionalismo em cada visita.', stars: 5 },
];

function initTestimonials() {
  let active = 0;
  const textEl  = document.getElementById('testem-text');
  const nameEl  = document.getElementById('testem-name');
  const starsEl = document.getElementById('testem-stars');
  const initEl  = document.getElementById('testem-initial');
  const dotsEl  = document.getElementById('testem-dots');
  if (!textEl) return;

  function renderDots() {
    dotsEl.innerHTML = TESTIMONIALS.map((_, i) => `
      <button class="testem-dot${i === active ? ' active' : ''}" data-i="${i}"></button>`).join('');
    dotsEl.querySelectorAll('.testem-dot').forEach(btn => {
      btn.addEventListener('click', () => { active = +btn.dataset.i; update(); });
    });
  }
  function update() {
    const t = TESTIMONIALS[active];
    textEl.textContent  = t.text;
    nameEl.textContent  = t.name;
    starsEl.textContent = '★'.repeat(t.stars);
    initEl.textContent  = t.name[0];
    renderDots();
  }
  update();
  setInterval(() => { active = (active + 1) % TESTIMONIALS.length; update(); }, 4500);

  const grid = document.getElementById('testem-grid');
  if (grid) {
    grid.innerHTML = TESTIMONIALS.map(t => `
      <div class="testem-card">
        <div style="color:var(--gold);font-size:14px;margin-bottom:8px">${'★'.repeat(t.stars)}</div>
        <p style="font-size:13px;color:#888;line-height:1.7;margin:0 0 12px">${t.text}</p>
        <div style="font-weight:600;font-size:13px;color:#bbb">${t.name}</div>
      </div>`).join('');
  }
}

// ─── NAV ──────────────────────────────────────────────────────────────────────

function initNav() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 60));
  const hamburger  = document.getElementById('hamburger-btn');
  const mobileMenu = document.getElementById('mobile-menu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => mobileMenu.classList.toggle('open'));
    mobileMenu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => mobileMenu.classList.remove('open'));
    });
  }
}

// ─── PRODUTOS ─────────────────────────────────────────────────────────────────

async function renderSiteProducts() {
  const container = document.getElementById('site-products-grid');
  if (!container) return;
  try {
    const data     = await apiCall('/external/v1/products');
    const products = (data.products || []).filter(p => p.isActive !== false);
    if (!products.length) {
      container.innerHTML = '<p style="text-align:center;color:#555;padding:40px">Nenhum produto disponível.</p>';
      return;
    }
    container.innerHTML = `<div class="prod-grid">${products.map(prod => buildProductCard(prod)).join('')}</div>`;
  } catch (err) {
    console.error('[BarberPro] Erro produtos:', err.message);
    container.innerHTML = '<p style="text-align:center;color:#555;padding:40px">Não foi possível carregar os produtos.</p>';
  }
}

function getMainImage(prod) {
  const imgs = prod.images || [];
  const main = imgs.find(i => i.isMain) || imgs.sort((a, b) => a.position - b.position)[0];
  return main?.url || null;
}

function getFirstVariant(prod) {
  return (prod.variants || []).find(v => v.isActive !== false) || prod.variants?.[0] || null;
}

function buildProductCard(prod) {
  const imgUrl  = getMainImage(prod);
  const variant = getFirstVariant(prod);
  const sku     = variant?.sku || '';
  const sale    = parseFloat(variant?.price?.salePrice || 0);
  const list    = parseFloat(variant?.price?.listPrice  || 0);
  const hasDisc = sale > 0 && list > 0 && sale < list;
  const price   = sale > 0 ? sale : list;
  const wa      = WHATSAPP || '5500000000000';
  const waText  = encodeURIComponent(`Olá! Tenho interesse no produto: *${prod.name}*${sku ? ` (SKU: ${sku})` : ''}`);
  const waUrl   = `https://wa.me/${wa}?text=${waText}`;
  const badge   = prod.isFeatured ? '<div class="prod-badge">Destaque</div>' : '';
  return `
    <div class="prod-card">
      <div class="prod-photo">
        ${imgUrl
          ? `<img src="${imgUrl}" alt="${prod.name}" class="prod-img">`
          : `<div class="prod-photo-placeholder"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--gold-dark)" stroke-width="1.5" opacity=".4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`
        }
        ${badge}
        ${price > 0 ? `<div class="prod-price-badge">${fmtCurrency(price)}</div>` : ''}
      </div>
      <div class="prod-body">
        <div class="prod-name">${prod.name}</div>
        ${prod.description ? `<p class="prod-desc">${prod.description}</p>` : ''}
        <div class="prod-footer">
          <div class="prod-price-wrap">
            ${hasDisc ? `<span class="prod-list-price">${fmtCurrency(list)}</span>` : ''}
            ${price > 0 ? `<span class="prod-sale-price">${fmtCurrency(price)}</span>` : ''}
          </div>
          <a href="${waUrl}" target="_blank" rel="noopener" class="prod-buy-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            Comprar
          </a>
        </div>
      </div>
    </div>`;
}

// ─── CONFIG MODAL ─────────────────────────────────────────────────────────────

function openConfigModal() {
  const cfg = loadConfig();
  document.getElementById('cfg-business-name').value = cfg.businessName;
  document.getElementById('cfg-api-url').value        = cfg.apiUrl;
  document.getElementById('cfg-api-key').value        = cfg.apiKey;
  document.getElementById('cfg-api-secret').value     = cfg.apiSecret;
  document.getElementById('cfg-whatsapp').value       = cfg.whatsapp;
  document.getElementById('config-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeConfigModal() {
  document.getElementById('config-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function handleConfigSave() {
  const cfg = {
    businessName: document.getElementById('cfg-business-name').value.trim(),
    apiUrl:       document.getElementById('cfg-api-url').value.trim().replace(/\/$/, ''),
    apiKey:       document.getElementById('cfg-api-key').value.trim(),
    apiSecret:    document.getElementById('cfg-api-secret').value.trim(),
    whatsapp:     document.getElementById('cfg-whatsapp').value.replace(/\D/g, ''),
  };
  persistConfig(cfg);
  showToast('Configurações salvas! Recarregando...', 'success');
  setTimeout(() => location.reload(), 1200);
}

function initConfigModal() {
  document.getElementById('settings-btn').addEventListener('click', openConfigModal);
  document.getElementById('mobile-settings-btn')?.addEventListener('click', () => {
    document.getElementById('mobile-menu')?.classList.remove('open');
    openConfigModal();
  });
  document.getElementById('config-close').addEventListener('click', closeConfigModal);
  document.getElementById('btn-config-cancel').addEventListener('click', closeConfigModal);
  document.getElementById('config-overlay').addEventListener('click', e => {
    if (e.target.id === 'config-overlay') closeConfigModal();
  });
  document.getElementById('btn-config-save').addEventListener('click', handleConfigSave);

  const secretInput = document.getElementById('cfg-api-secret');
  const toggleBtn   = document.getElementById('cfg-secret-toggle');
  toggleBtn?.addEventListener('click', () => {
    if (secretInput.type === 'password') {
      secretInput.type  = 'text';
      toggleBtn.textContent = 'Ocultar';
    } else {
      secretInput.type  = 'password';
      toggleBtn.textContent = 'Mostrar';
    }
  });

  const cfg = loadConfig();
  if (!cfg.apiUrl || !cfg.apiKey) {
    const banner = document.getElementById('config-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.addEventListener('click', openConfigModal);
    }
  }
}

// ─── APPLY CONFIG ─────────────────────────────────────────────────────────────

function applyConfig() {
  const cfg = loadConfig();
  API_URL    = cfg.apiUrl;
  API_KEY    = cfg.apiKey;
  API_SECRET = cfg.apiSecret;
  WHATSAPP   = cfg.whatsapp;

  const name = cfg.businessName || 'Premier Barber';
  document.querySelectorAll('[data-business-name]').forEach(el => { el.textContent = name; });
  document.title = `${name} — Site de Apresentação`;

  const waNumber = WHATSAPP || '5500000000000';
  document.querySelectorAll('[data-wa-link]').forEach(el => { el.href = `https://wa.me/${waNumber}`; });
  document.querySelectorAll('[data-wa-text]').forEach(el => {
    if (WHATSAPP) {
      const d   = WHATSAPP.replace(/^55/, '');
      const fmt = d.length === 11
        ? `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`
        : `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
      el.textContent = fmt;
    }
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  state.weekStart = getWeekStart(new Date());

  applyConfig();
  initNav();
  initTestimonials();
  initConfigModal();

  // Botões "AGENDAR" genéricos rolam para serviços
  document.querySelectorAll('.btn-agendar').forEach(btn => {
    btn.addEventListener('click', () =>
      document.getElementById('servicos')?.scrollIntoView({ behavior: 'smooth' })
    );
  });
  document.querySelector('.nav-book-btn-desktop')?.addEventListener('click', () =>
    document.getElementById('servicos')?.scrollIntoView({ behavior: 'smooth' })
  );

  // Booking modal — controles base
  document.getElementById('modal-close').addEventListener('click', closeBookingModal);
  document.getElementById('booking-overlay').addEventListener('click', e => {
    if (e.target.id === 'booking-overlay') closeBookingModal();
  });
  document.getElementById('btn-voltar').addEventListener('click', handleVoltar);
  document.getElementById('btn-continuar').addEventListener('click', handleContinuar);
  document.getElementById('btn-confirmar').addEventListener('click', handleConfirmar);

  // Botões de decisão do carrinho (step 5)
  document.getElementById('btn-decision-sim')?.addEventListener('click', handleDecisionSim);
  document.getElementById('btn-decision-nao')?.addEventListener('click', handleDecisionNao);

  // Fechar tela de sucesso
  document.getElementById('btn-success-close')?.addEventListener('click', () => {
    resetFullBooking();
    closeBookingModal();
  });

  // Carregar dados da API
  if (API_URL && API_KEY) {
    try {
      const [svcData, empData] = await Promise.all([
        apiCall('/external/v1/services'),
        apiCall('/external/v1/booking/employees'),
      ]);
      state.services   = svcData.services  || [];
      state.categories = extractCategories(state.services);
      state.employees  = empData.employees || [];
      renderSiteServices();
      renderSiteTeam();
    } catch (err) {
      console.error('[BarberPro] Erro ao carregar dados:', err.message);
      document.getElementById('site-services-grid').innerHTML =
        '<p style="text-align:center;color:#666;padding:40px">Erro ao carregar serviços. Verifique as configurações.</p>';
      document.getElementById('site-team-grid').innerHTML = '';
    }
    renderSiteProducts();
  } else {
    const noConfig = `<p style="text-align:center;color:#555;padding:40px">
      Configure a integração para exibir os dados.
      <br><br>
      <button onclick="openConfigModal()" style="background:var(--gold);color:var(--black);border:none;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;border-radius:2px;font-family:Outfit">
        ⚙️ Abrir Configurações
      </button>
    </p>`;
    document.getElementById('site-services-grid').innerHTML  = noConfig;
    document.getElementById('site-team-grid').innerHTML      = '<p style="text-align:center;color:#555;padding:40px">Configure a integração para exibir a equipe.</p>';
    document.getElementById('site-products-grid').innerHTML  = '<p style="text-align:center;color:#555;padding:40px">Configure a integração para exibir os produtos.</p>';
  }
}

window.openConfigModal = openConfigModal;

document.addEventListener('DOMContentLoaded', init);
