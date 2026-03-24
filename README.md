# Painel QR com Autenticação

Aplicação Node.js com frontend estático para cadastrar produtos, gerar links públicos e baixar a arte final com QR Code.
Também inclui campanhas de sorteio com QR público: cada campanha usa um conjunto fechado de produtos e cada item só pode sair uma vez dentro daquele sorteio.

## Como funciona a autenticação

- O login aceita `e-mail` ou `login` + `senha`.
- A sessão é criada no backend e persistida no MongoDB.
- O navegador recebe apenas um cookie `httpOnly` (`qr_admin_session`), com `SameSite=Lax`.
- Ao recarregar a página, a sessão continua válida enquanto o cookie e a sessão no banco não expirarem.
- O logout remove a sessão no banco, limpa o cookie e redireciona para `/login`.

## Rotas públicas e privadas

Públicas:

- `/login`
- `/produto/:slug`
- `/sorteio/:slug`
- `/api/public/products/:slug`
- `/api/public/raffles/:slug`
- `/api/public/raffles/:slug/draw`
- `/api/public/art-templates/:id/image`
- Assets públicos necessários para a página do produto, como `/styles.css`, `/product.js` e `/uploads/...`

Privadas:

- `/`
- `/produtos`
- `/sorteios`
- `/arte/:slug`
- `/api/products`
- `/api/products/:slug`
- `/api/raffles`
- `/api/art-templates`
- `/api/art-templates/:id/image`
- `/api/qrcode`
- `/api/auth/session`
- `/api/auth/logout`

Se um usuário não autenticado tentar abrir uma página privada, será redirecionado para `/login`. Se a sessão expirar durante chamadas AJAX, o frontend redireciona para login novamente.

## Usuário admin inicial

No primeiro boot, se ainda não existir nenhum usuário admin no banco, o servidor cria um admin inicial usando estas variáveis do `.env`:

```env
ADMIN_NAME=Administrador
ADMIN_EMAIL=admin@example.local
ADMIN_LOGIN=admin
ADMIN_PASSWORD=admin123456
```

Esses valores estão documentados em `.env.example`. Em produção, altere principalmente `ADMIN_PASSWORD` antes de subir a aplicação.

## Criar ou atualizar o admin manualmente

Você também pode criar ou sobrescrever o admin manualmente pelo backend:

```bash
npm run admin:create -- --name "Administrador" --email admin@empresa.com --login admin --password "senha-forte"
```

Se algum argumento não for informado, o script tenta usar a variável correspondente do `.env`.

## Como rodar

1. Configure o MongoDB e copie `.env.example` para `.env`, ajustando as credenciais do admin.
2. Instale dependências com `npm install`.
3. Rode `npm run dev` ou `npm start`.

## Fluxo do painel

- `/login`: tela de autenticação.
- `/`: cadastro e edição de produto.
- `/produtos`: listagem privada de produtos.
- `/sorteios`: criação de campanhas de sorteio com QR público.
- Ao criar um sorteio, o sistema congela os produtos cadastrados naquele momento como elegíveis para aquela campanha.
- `/arte/:slug`: arte final privada para download.
- `/produto/:slug`: página pública final do produto.
- `/sorteio/:slug`: página pública que consome 1 produto aleatório ainda não distribuído naquela campanha.
