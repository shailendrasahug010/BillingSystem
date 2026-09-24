import { generateJwtKeyPairPem } from "../src/lib/security.js";

// Prints a fresh Ed25519 key pair for the access-token signer, in the
// single-line form .env files expect. Keep the private key secret.
const { privateKey, publicKey } = await generateJwtKeyPairPem();
const oneLine = (pem: string) => pem.trim().replaceAll("\n", "\\n");
console.log(`JWT_PRIVATE_KEY="${oneLine(privateKey)}"`);
console.log(`JWT_PUBLIC_KEY="${oneLine(publicKey)}"`);
