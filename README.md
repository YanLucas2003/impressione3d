# impressione3d

Loja estatica com checkout Mercado Pago, Firebase Auth/Firestore e deploy Netlify.

## Variaveis de ambiente obrigatorias

Configure no provedor de deploy:

- `MP_ACCESS_TOKEN`: token privado do Mercado Pago.
- `FIREBASE_SERVICE_ACCOUNT`: JSON da service account do Firebase Admin em uma linha.

Alternativas aceitas para o Firebase Admin:

- `FIREBASE_SERVICE_ACCOUNT_BASE64`: JSON da service account em base64.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY`.

## Admin

O site nao cria mais usuario administrador pelo frontend. Crie o usuario no Firebase Authentication e defina o documento correspondente em `users/{uid}` com `tipo: "admin"`.

Se alguma credencial de admin ja foi publicada no historico do GitHub, troque essa senha no Firebase antes de usar o checkout em producao.
