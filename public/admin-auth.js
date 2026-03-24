const sessionLabels = Array.from(document.querySelectorAll('[data-admin-user]'));
const logoutButtons = Array.from(document.querySelectorAll('[data-logout-button]'));

function setSessionLabel(text, variant = '') {
  for (const label of sessionLabels) {
    label.textContent = text;
    label.className = 'status-badge';

    if (variant) {
      label.classList.add(variant);
    }
  }
}

function getCurrentReturnTo() {
  return `${window.location.pathname}${window.location.search}`;
}

function buildLoginUrl(returnTo = getCurrentReturnTo()) {
  const params = new URLSearchParams();
  params.set('returnTo', returnTo || '/');
  return `/login?${params.toString()}`;
}

function redirectToLogin(returnTo = getCurrentReturnTo()) {
  window.location.href = buildLoginUrl(returnTo);
}

async function authFetch(input, init) {
  const response = await fetch(input, init);

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Sua sessão expirou. Faça login novamente.');
  }

  return response;
}

async function loadSession() {
  const response = await authFetch('/api/auth/session');
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Não foi possível validar a sessão.');
  }

  const userLabel = payload.user?.name
    ? `${payload.user.name} @${payload.user.login}`
    : `Conectado como @${payload.user?.login || 'admin'}`;

  setSessionLabel(userLabel, 'is-ready');
  return payload.user;
}

async function logout() {
  for (const button of logoutButtons) {
    button.disabled = true;
    button.textContent = 'Saindo...';
  }

  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Não foi possível encerrar a sessão.');
    }

    window.location.href = '/login';
  } catch (error) {
    setSessionLabel(error.message, 'is-error');

    for (const button of logoutButtons) {
      button.disabled = false;
      button.textContent = 'Sair';
    }
  }
}

for (const button of logoutButtons) {
  button.addEventListener('click', logout);
}

window.adminSession = {
  buildLoginUrl,
  fetch: authFetch,
  loadSession,
  logout,
  redirectToLogin,
};

loadSession().catch((error) => {
  if (!/sessão expirou/i.test(error.message)) {
    setSessionLabel(error.message, 'is-error');
  }
});
