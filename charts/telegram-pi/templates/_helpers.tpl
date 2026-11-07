{{- define "telegram-pi.labels" -}}
app.kubernetes.io/name: telegram-pi
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "telegram-pi.version" -}}
{{- toJson .Values | sha256sum | trunc 12 -}}
{{- end }}

{{- define "telegram-pi.identity" -}}
- name: ate-identity
  projected:
    defaultMode: 0440
    sources:
      - clusterTrustBundle:
          signerName: servicedns.podcert.ate.dev/identity
          labelSelector:
            matchLabels:
              podcert.ate.dev/canarying: live
          path: ca.crt
      - podCertificate:
          signerName: podidentity.podcert.ate.dev/identity
          keyType: ECDSAP256
          credentialBundlePath: credential-bundle.pem
{{- end }}

{{- define "telegram-pi.security" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "telegram-pi.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end }}

{{- define "telegram-pi.providerEnv" -}}
- name: SUBSTRATE_ATESPACE
  value: {{ .Values.substrate.atespace | quote }}
- name: ACTOR_TEMPLATE
  value: {{ .Values.substrate.actorTemplate | quote }}
- name: ACTOR_IMAGE
  value: {{ .Values.images.actor | quote }}
- name: OPENAI_BASE_URL
  value: {{ .Values.openai.baseUrl | quote }}
- name: OPENAI_MODEL
  value: {{ .Values.openai.model | quote }}
- name: OPENAI_MODEL_METADATA
  value: {{ .Values.openai.modelMetadata | quote }}
- name: OPENAI_API_KEY
  value: substrate-egress-placeholder
- name: LLM_CREDENTIAL_URI
  value: {{ .Values.openai.credentialUri | quote }}
- name: DEVELOPMENT_HOSTS
  value: {{ join "," .Values.developmentHosts | quote }}
- name: WORKER_POOL_LABEL
  value: telegram-pi
- name: SUBSTRATE_CA_FILE
  value: /var/run/ate/ca.crt
- name: SUBSTRATE_CREDENTIAL_BUNDLE
  value: /var/run/ate/credential-bundle.pem
{{- end }}
