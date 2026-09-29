uma versão 100% local, usando:

Node.js + TypeScript
AWS Cognito → simulado pelo LocalStack
Terraform → infraestrutura
Lambda → lógica de autenticação
API Gateway → endpoint /login
SES → simulado pelo LocalStack para capturar o e-mail
KMS → para gerar/proteger o token
DynamoDB → eu usaria no projeto, em vez do custom attribute do Cognito
Frontend simples → React/Vite ou até HTML/JS inicialmente
Docker Compose → subir todo o ambiente
testes automatizados

O artigo que você mandou é justamente uma implementação de passwordless authentication via magic link, usando os três triggers de custom authentication do Cognito: DefineAuthChallenge, CreateAuthChallenge e VerifyAuthChallengeResponse.

O projeto que eu faria
                    ┌──────────────────┐
                    │    Frontend      │
                    │ React / Vite     │
                    └────────┬─────────┘
                             │
                       POST /login
                             │
                             ▼
                    ┌──────────────────┐
                    │   API Gateway    │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Lambda: login    │
                    │                  │
                    │ generate token   │
                    │ save token       │
                    │ send email       │
                    └──────┬─────┬─────┘
                           │     │
                  ┌────────┘     └────────┐
                  ▼                       ▼
             DynamoDB                   SES
          token + expiry             fake email
                                          │
                                          ▼
                                  ┌───────────────┐
                                  │ Magic Link    │
                                  │ localhost...  │
                                  └───────┬───────┘
                                          │
                                          ▼
                                  Frontend recebe
                                  email + token
                                          │
                                          ▼
                                  Cognito CUSTOM_AUTH
                                          │
                         ┌────────────────┼────────────────┐
                         ▼                ▼                ▼
                  DefineChallenge   CreateChallenge   VerifyChallenge
                         │                │                │
                         └────────────────┼────────────────┘
                                          ▼
                                    JWT tokens

Essa arquitetura também resolve justamente o problema de Session descrito no artigo: o processo inicial é iniciado pelo seu /login, e o fluxo Cognito só começa quando o usuário abre o magic link.

E tem uma diferença importante

Para portfólio, eu não copiaria literalmente a implementação do artigo.

O artigo guarda o token atual em um custom attribute do Cognito. O próprio autor observa que isso cria uma limitação de throughput porque AdminSetUserAttribute tem limite de requisições.

Eu faria:

DynamoDB
   │
   ├── email
   ├── tokenHash
   ├── expiresAt
   ├── used
   └── createdAt

E nunca armazenaria o token puro.

Por exemplo:

magic link:

http://localhost:5173/auth/callback
    ?email=luiz@example.com
    &token=7f8a9...

No banco:

tokenHash = SHA256(token)
expiresAt = now + 10 minutes
used = false

Quando o usuário clicar:

token recebido
      ↓
SHA256(token)
      ↓
buscar no DynamoDB
      ↓
existe?
      ↓
não expirou?
      ↓
não usado?
      ↓
email corresponde?
      ↓
SIM
      ↓
Cognito CUSTOM_AUTH
      ↓
JWT

Isso deixa o projeto muito mais interessante tecnicamente.

Estrutura do repositório

Eu montaria assim:

passwordless-cognito/
│
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── handlers/
│   │       │   ├── login.ts
│   │       │   └── auth-callback.ts
│   │       │
│   │       ├── services/
│   │       │   ├── token.service.ts
│   │       │   ├── email.service.ts
│   │       │   └── cognito.service.ts
│   │       │
│   │       └── repositories/
│   │           └── magic-link.repository.ts
│   │
│   ├── cognito/
│   │   └── triggers/
│   │       ├── define-auth-challenge.ts
│   │       ├── create-auth-challenge.ts
│   │       └── verify-auth-challenge.ts
│   │
│   └── frontend/
│       └── ...
│
├── infrastructure/
│   └── terraform/
│       ├── main.tf
│       ├── cognito.tf
│       ├── lambda.tf
│       ├── dynamodb.tf
│       ├── api-gateway.tf
│       ├── ses.tf
│       ├── iam.tf
│       └── variables.tf
│
├── tests/
│   ├── integration/
│   └── unit/
│
├── docker-compose.yml
├── Makefile
├── package.json
├── tsconfig.json
└── README.md

Isso já começa a parecer um projeto de backend de verdade, e não simplesmente um tutorial reproduzido.

O fluxo que vamos implementar
1. Usuário entra no site
Email:

[ luiz@example.com ]

[ Send magic link ]

Frontend:

POST /login

{
  "email": "luiz@example.com"
}
2. Backend gera token
const token = randomBytes(32).toString("hex");

Não usamos:

Math.random()

nem JWT como magic-link token.

Depois:

const tokenHash = createHash("sha256")
  .update(token)
  .digest("hex");
3. DynamoDB
PK: EMAIL#luiz@example.com

tokenHash
expiresAt
used
createdAt

TTL pode cuidar da limpeza.

4. SES local

O Lambda manda:

Subject:
Your magic login link

Click here:

http://localhost:5173/auth/callback?email=...&token=...

No LocalStack você não precisa realmente mandar o e-mail para a internet.

Podemos inspecionar o e-mail capturado localmente.

5. Usuário clica

Frontend recebe:

/auth/callback?email=...&token=...

E chama o Cognito.

InitiateAuth({
  AuthFlow: "CUSTOM_AUTH",
  ClientId,
  AuthParameters: {
    USERNAME: email,
  }
});

O Cognito então entra no fluxo:

DefineAuthChallenge
        ↓
CreateAuthChallenge
        ↓
RespondToAuthChallenge
        ↓
VerifyAuthChallengeResponse
        ↓
DefineAuthChallenge
        ↓
AuthenticationResult

Esse é o fluxo oficial de custom authentication do Cognito.

E aí vem a parte legal do portfólio

Você consegue mostrar no README:

Security
✓ Passwordless authentication
✓ Cryptographically secure tokens
✓ SHA-256 token hashing
✓ Token expiration
✓ Single-use tokens
✓ Token invalidation
✓ Email ownership verification
✓ Cognito custom authentication
✓ No plaintext tokens stored
✓ Infrastructure as Code
✓ Local AWS emulation

Isso é muito mais interessante para uma vaga Backend Node/TypeScript do que simplesmente:

"CRUD API with Node.js"

Terraform

Também dá para demonstrar que você entende infraestrutura.

Por exemplo:

resource "aws_cognito_user_pool" "main" {
  name = "passwordless-users"

  username_attributes = ["email"]

  lambda_config {
    define_auth_challenge          = aws_lambda_function.define_auth.arn
    create_auth_challenge          = aws_lambda_function.create_auth.arn
    verify_auth_challenge_response = aws_lambda_function.verify_auth.arn
  }
}

E:

resource "aws_dynamodb_table" "magic_links" {
  name         = "magic-links"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
LocalStack

E o mais legal:

docker compose up -d

Depois:

terraform init
terraform apply

E o projeto inteiro sobe localmente.

Você poderia chegar numa entrevista e demonstrar:

$ make up

Starting LocalStack...

$ make infra

Applying Terraform...

✓ Cognito User Pool
✓ Cognito Client
✓ DynamoDB
✓ API Gateway
✓ Lambda
✓ SES
✓ IAM

Depois:

$ npm test

✓ token generation
✓ token expiration
✓ token reuse prevention
✓ invalid token
✓ wrong email
✓ successful authentication

Isso é um ótimo projeto de portfólio para backend TypeScript/Node.js, especialmente porque mostra AWS, autenticação, segurança, serverless, IaC, testes e arquitetura — sem precisar pagar AWS.

Eu faria em 3 etapas

Etapa 1 — infraestrutura

Docker
LocalStack
Terraform
Cognito
DynamoDB
SES
Lambda
API Gateway

Etapa 2 — backend

POST /login
magic token
DynamoDB
email
Cognito custom auth
JWT

Etapa 3 — qualidade de portfólio

TypeScript
unit tests
integration tests
Docker
README
architecture diagram
security considerations
CI/CD

E eu não começaria pelo frontend. Primeiro fazemos o backend funcionar completamente pelo curl/Postman. Depois colocamos uma interface simples em cima.

montar o projeto inteiro passo a passo, começando pelo docker-compose.yml + Terraform + LocalStack, depois os Lambdas em TypeScript, e no final  um README de GitHub apresentável.