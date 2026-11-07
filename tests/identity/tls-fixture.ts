import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Ephemeral loopback certificates. These are not Substrate identities or platform proof.
export function tlsFixture() {
  const directory = mkdtempSync(join(tmpdir(), "substrate-client-tls-"))
  const run = (...args: string[]) =>
    execFileSync("openssl", args, {
      cwd: directory,
      stdio: "ignore",
      timeout: 10_000,
    })
  run(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Loopback fixture CA",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
  )
  function leaf(name: string, san: string, purpose: "serverAuth" | "clientAuth") {
    run(
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
    )
    writeFileSync(
      join(directory, `${name}.ext`),
      `subjectAltName=${san}\nextendedKeyUsage=${purpose}\nbasicConstraints=CA:FALSE\n`,
    )
    run(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.crt`,
    )
    const key = readFileSync(join(directory, `${name}.key`))
    const cert = readFileSync(join(directory, `${name}.crt`))
    return { key, cert, bundle: Buffer.concat([key, cert]) }
  }
  const ca = readFileSync(join(directory, "ca.crt"))
  const server = leaf("server", "DNS:localhost,DNS:api.ate-system.svc", "serverAuth")
  const gateway = leaf("gateway", "URI:spiffe://fixture/ns/app/sa/gateway", "clientAuth")
  const renewed = leaf("renewed", "URI:spiffe://fixture/ns/app/sa/gateway", "clientAuth")
  const unlisted = leaf("unlisted", "URI:spiffe://fixture/ns/app/sa/provisioner", "clientAuth")
  return { directory, ca, server, gateway, renewed, unlisted }
}
