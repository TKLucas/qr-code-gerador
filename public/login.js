const loginForm = document.querySelector('#login-form');
const identifierInput = document.querySelector('#identifier-input');
const passwordInput = document.querySelector('#password-input');
const loginSubmitButton = document.querySelector('#login-submit-button');
const loginStatus = document.querySelector('#login-status');
const loginBadge = document.querySelector('#login-badge');

function getReturnTo() {
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get('returnTo') || '/';

  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.startsWith('/login')) {
    return '/';
  }

  return returnTo;
}

function setLoginStatus(text, variant = '') {
  loginStatus.textContent = text;
  loginStatus.className = 'helper-text';

  if (variant) {
    loginStatus.classList.add(variant);
  }
}

function setLoginBadge(text, variant = '') {
  loginBadge.textContent = text;
  loginBadge.className = 'status-badge';

  if (variant) {
    loginBadge.classList.add(variant);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  loginSubmitButton.disabled = true;
  setLoginBadge('Entrando', 'is-loading');
  setLoginStatus('Validando credenciais...');

  try {
    const response = await fetch(`/api/auth/login?returnTo=${encodeURIComponent(getReturnTo())}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        identifier: identifierInput.value.trim(),
        password: passwordInput.value,
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível fazer login.');
    }

    setLoginBadge('Redirecionando', 'is-ready');
    setLoginStatus('Login realizado com sucesso.', 'is-ready');
    window.location.href = payload.redirectTo || getReturnTo();
  } catch (error) {
    passwordInput.value = '';
    loginSubmitButton.disabled = false;
    setLoginBadge('Erro', 'is-error');
    setLoginStatus(error.message, 'is-error');
    passwordInput.focus();
  }
});
