#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]]; then
  echo 'Local validation tools require Linux x86_64.' >&2
  exit 1
fi

mkdir -p .cache/tools
work="$(mktemp -d .cache/tools/download.XXXXXX)"
trap 'rm -rf "$work"' EXIT

curl --fail --silent --show-error --location --retry 2 \
  https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-amd64 -o "$work/kind"
printf '%s  %s\n' \
  aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d "$work/kind" \
  | sha256sum --check
install -m 755 "$work/kind" .cache/tools/kind

curl --fail --silent --show-error --location --retry 2 \
  https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz -o "$work/helm.tar.gz"
printf '%s  %s\n' \
  0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b "$work/helm.tar.gz" \
  | sha256sum --check
tar -xzf "$work/helm.tar.gz" -C "$work" linux-amd64/helm
install -m 755 "$work/linux-amd64/helm" .cache/tools/helm

curl --fail --silent --show-error --location --retry 2 \
  https://github.com/argoproj/argo-cd/releases/download/v3.6.1/argocd-linux-amd64 -o "$work/argocd"
printf '%s  %s\n' \
  46d2fc941071f0a0c36326a67a431d34b1479e1a24737f7b367abc93968beadc "$work/argocd" \
  | sha256sum --check
install -m 755 "$work/argocd" .cache/tools/argocd

curl --fail --silent --show-error --location --retry 2 \
  https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl -o "$work/kubectl"
printf '%s  %s\n' \
  6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f "$work/kubectl" \
  | sha256sum --check
install -m 755 "$work/kubectl" .cache/tools/kubectl

.cache/tools/kubectl version --client
.cache/tools/kind version
.cache/tools/helm version --short
env -i HOME="$HOME" PATH="$PATH" .cache/tools/argocd version --client --short
