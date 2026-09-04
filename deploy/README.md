# Oracle 배포 및 Obsidian 동기화

이 배포는 한 Oracle Ubuntu VM에서 다음 세 가지를 함께 실행한다.

> [!WARNING] 현재 배포 승인 범위
> 이 검토 커밋은 **provider-disabled 상태와 정확히 6개 knowledge tool 배포만 승인**되었다.
> Provider 설치, `dry-run`, 13개 tool 노출, 자동 정리는 모두 **차단(BLOCKED)** 상태다.
> `fitNoteContent()`의 emoji surrogate-pair 무한 루프와 `candidateNotes`/`approvedDirectories`
> 민감 경로 유출 가능성을 수정하고 독립 재검토가 통과하기 전에는 provider key를 넣거나
> organizer mode를 `dry-run`/`automatic`으로 바꾸지 않는다. 아래 명령도 provider-disabled
> 상태 점검과 복구에만 사용한다.

- `brain-mcp`: 여러 Obsidian Vault를 검색하는 OAuth 보호 MCP 서버
- `brain-syncthing`: PC·Android와 Vault Markdown 파일을 양방향 동기화
- `caddy`: 공개 HTTPS 주소와 인증서
- `brain-organizer.timer`: 매일 18:00 UTC에 provider-disabled organizer를 안전하게 점검

## 서버 설치

릴리스 압축을 `/tmp/brain-release`에 푼 뒤 다음 환경값으로 실행한다. Vault ID는 영문 소문자, 숫자, `_`, `-`만 사용할 수 있다.

```bash
sudo PUBLIC_HOST=203-0-113-10.sslip.io \
  RELEASE_DIR=/tmp/brain-release \
  BRAIN_VAULT_IDS=brain \
  bash /tmp/brain-release/deploy/install.sh
```

처음에는 새 빈 Vault `brain` 하나만 만든다. 기존 로컬 Obsidian Vault는 읽거나 복사하지 않는다. 나중에 새 Vault를 더 만들고 싶을 때만 `BRAIN_VAULT_IDS=brain,work,research`처럼 추가한다. 설치기는 기존 로그인 비밀번호와 JWT 비밀값을 재사용하므로 다시 실행해도 인증 정보가 바뀌지 않는다.

설치기는 `brain-organizer.timer`를 **enable만 하고 start하지 않는다**. 따라서 설치 직후에는
`enabled`이지만 다음 부팅 또는 별도로 승인된 안전한 시작 전까지 `inactive`일 수 있으며,
`systemctl status`에는 `inactive (dead)`로 보일 수 있다. 이는 정상 상태다. Timer를 시작하면
`Persistent=true` 때문에 놓친 시간이 즉시 catch-up 실행될 수 있으므로 현재 배포 절차에서는
timer를 시작하지 않는다. 상태만 확인한다.

```bash
sudo systemctl is-enabled brain-organizer.timer
sudo systemctl show --property=ActiveState --value brain-organizer.timer
```

## Oracle 인바운드 규칙

다음 포트만 연다. `8384`와 `8787`은 외부에 열지 않는다.

| 포트 | 프로토콜 | 용도 |
|---|---|---|
| 22 | TCP | 관리자 SSH |
| 80, 443 | TCP | HTTPS 인증서와 MCP |
| 22000 | TCP, UDP | Syncthing 직접 동기화 |

22000이 막혀도 Syncthing 릴레이로 연결될 수 있지만 더 느리다. UDP 21027은 같은 LAN 검색용이므로 Oracle 서버에는 열지 않는다.

## 서비스 확인

```bash
systemctl is-active brain-mcp brain-syncthing caddy
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8384/rest/noauth/health
curl -i "https://${PUBLIC_HOST}/healthz"
curl -i -X POST "https://${PUBLIC_HOST}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

세 서비스는 `active`, 두 health 요청은 `200`, 로그인하지 않은 MCP 요청은 `401`이어야 한다.

## FLOW 읽기 전용 연결

설치기는 `/etc/brain-mcp-service-clients.json`을 `root:brain`, 권한 `0640`으로 만들고
`/etc/brain-mcp.env`의 `MCP_SERVICE_CLIENTS_FILE`에 연결한다. 초기 내용은 빈 client 목록이라
FLOW 권한은 아직 없다.

먼저 32자 이상의 새 secret을 FLOW 배포 환경의 `OBRAIN_MCP_CLIENT_SECRET`에 안전하게
저장한다. 같은 값을 아래 숨김 입력에 한 번 넣는다. helper는 scrypt hash만 반환하며 raw
secret을 파일이나 출력에 남기지 않는다.

```bash
cd /opt/brain-mcp
read -rsp 'FLOW client secret: ' flow_client_secret
echo
flow_secret_hash=$(
  MCP_SERVICE_CLIENT_SECRET="$flow_client_secret" \
    /usr/bin/node scripts/hash-service-secret.mjs
)
unset flow_client_secret
service_clients_tmp=$(mktemp /etc/brain-mcp-service-clients.json.tmp.XXXXXX)
jq -n --arg hash "$flow_secret_hash" '{
  clients: [{
    clientId: "flow",
    secretHash: $hash,
    ownerId: "owner",
    scopes: ["notes:read"],
    allowedVaults: ["brain"],
    enabled: true
  }]
}' >"$service_clients_tmp"
install -o root -g brain -m 0640 "$service_clients_tmp" \
  /etc/brain-mcp-service-clients.json
rm -f "$service_clients_tmp"
unset flow_secret_hash
systemctl restart brain-mcp
systemctl is-active brain-mcp
```

FLOW 또는 Railway에는 다음 변수명만 설정한다. Secret 값은 로그, GitHub, Obsidian 노트,
이 문서에 복사하지 않는다.

```dotenv
BRAIN_PROVIDER=obrain-mcp
OBRAIN_MCP_URL=https://144-24-67-37.sslip.io/mcp
OBRAIN_MCP_CLIENT_ID=flow
OBRAIN_MCP_CLIENT_SECRET=<protected secret>
OBRAIN_MCP_VAULTS=brain
OBRAIN_SYNC_SECRET=<separate protected scheduler secret>
OBRAIN_SYNC_MAX_STALE_SECONDS=900
```

초기 동기화는 FLOW에서 `npm run brain:sync`를 한 번 실행하거나, 보호된
`POST /api/brain/sync`에 `Authorization: Bearer <OBRAIN_SYNC_SECRET>`를 보내 시작한다. 응답은
cursor와 생성·수정·삭제 개수만 반환한다. FLOW client에는 Markdown 쓰기·삭제·organizer
tool이 노출되지 않는다.

운영 서버에서는 `deploy/flow-obrain-sync.service`와 `deploy/flow-obrain-sync.timer`를 설치해
Oracle이 5분마다 FLOW의 보호된 HTTPS sync route를 호출할 수 있다. 실제
`/etc/flow-obrain-sync.env`는 `root:brain`, 권한 `0640`으로 만들고 다음 이름만 설정한다.

```dotenv
FLOW_SYNC_URL=https://flow.example.com/api/brain/sync
OBRAIN_SYNC_SECRET=<protected scheduler secret>
```

Wrapper와 unit을 각각 `/usr/local/sbin/flow-obrain-sync`와 `/etc/systemd/system/`에 설치한 뒤
`systemctl enable --now flow-obrain-sync.timer`를 실행한다. 최초 확인은
`systemctl start flow-obrain-sync.service` 후 `Result=success`, `ExecMainStatus=0`, timer가
`active`인지 확인한다. Secret 값이나 Authorization header는 로그에 출력하지 않는다.

Secret을 교체할 때는 새 client ID(예: `flow-next`)와 새 hash를 기존 항목 옆에 먼저 추가하고,
FLOW의 ID와 secret을 바꿔 동기화를 확인한 뒤 이전 `flow` 항목을 제거한다. 같은 client ID를
중복해서 넣으면 서버가 시작을 거부한다. 긴급 차단은 해당 항목의 `enabled`를 `false`로 바꾸고
`brain-mcp`를 재시작한다.

## Organizer 운영 확인 — provider-disabled 전용

현재 허용된 상태에서는 `/etc/brain-organizer.env`의
`ORGANIZER_PROVIDER=disabled`와 `/etc/brain-mcp-config.json`의
`organizer.mode="disabled"`를 유지한다. 인증된 배포 검증기는 별도 플래그 없이 실행하며
정확히 6개 tool과 기존 생성·읽기·검색 왕복을 확인해야 한다.

```bash
sudo grep -qx 'ORGANIZER_PROVIDER=disabled' /etc/brain-organizer.env
sudo jq -e '.organizer.mode == "disabled"' /etc/brain-mcp-config.json >/dev/null
sudo systemctl status brain-organizer.timer --no-pager
sudo systemctl list-timers brain-organizer.timer --no-pager
sudo -u brain env MCP_CONFIG_FILE=/etc/brain-mcp-config.json \
  /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js audit --vault brain
sudo env DEPLOY_OWNER_PASSPHRASE_FILE=/root/brain-mcp-owner-passphrase.txt \
  /usr/bin/node /opt/brain-mcp/scripts/verify-deployment.mjs \
  https://203-0-113-10.sslip.io
```

마지막 URL은 실제 Oracle 공개 hostname으로 바꾼다. 검증기는 passphrase 파일 내용을 출력하지
않고 기본 상태에서 6개 tool 외의 surface를 발견하면 실패한다.

예약된 service와 같은 provider-disabled 실행 경로를 한 번 확인할 때만 다음을 사용한다.
이 실행은 7일 trial을 시작하지 않으며 provider를 호출하거나 노트를 이동하지 않아야 한다.
Oneshot이 성공하면 계속 active로 남지 않고 보통 `inactive (dead)`로 돌아오는 것이 정상이다.
`Result=success`, `ExecMainStatus=0`, `ActiveState=inactive`를 확인한다.

```bash
sudo systemctl start brain-organizer.service
sudo systemctl show --property=Result --property=ExecMainStatus \
  --property=ActiveState brain-organizer.service
```

`sudo systemctl edit --runtime brain-organizer.timer`는 수정 사항과 독립 재검토가 모두 끝난
후의 제한된 trial 일정 조정용으로만 예약한다. 현재 차단 상태에서는 실행하거나 runtime
override를 만들지 않는다. `DEPLOY_EXPECT_ORGANIZER=1`도 13개 tool 배포를 승인하는 스위치가
아니며, 차단 해제 후 이미 승인된 13개 surface를 검증할 때만 사용할 수 있다.

### 긴급 비활성화

향후 승인된 trial 중 문제가 생기면 먼저 timer와 실행 중인 organizer service를 모두
멈추고 service가 inactive인지 확인한다. 그 다음 protected environment를 열어
`ORGANIZER_PROVIDER=disabled`로 바꾸고 검증한 뒤 MCP만 재시작한다. Key 값은 명령줄, 로그,
문서에 복사하지 않는다. Timer는 enabled 상태를 유지하되 이 복구 세션에서는 inactive로
남겨 catch-up 실행을 만들지 않는다.

```bash
set -euo pipefail
sudo systemctl stop brain-organizer.timer brain-organizer.service
sudo systemctl reset-failed brain-organizer.service
sudo systemctl show --property=ActiveState --value brain-organizer.service | grep -qx inactive
sudoedit /etc/brain-organizer.env
sudo grep -qx 'ORGANIZER_PROVIDER=disabled' /etc/brain-organizer.env
sudo chown root:brain /etc/brain-organizer.env
sudo chmod 0640 /etc/brain-organizer.env
sudo systemctl restart brain-mcp
sudo systemctl is-active brain-mcp
sudo systemctl is-enabled brain-organizer.timer
sudo systemctl show --property=ActiveState --value brain-organizer.timer | grep -qx inactive
sudo systemctl show --property=ActiveState --value brain-organizer.service | grep -qx inactive
```

### Guarded undo

기존 transaction을 복구할 때만 timer, 실행 중인 organizer service, writer와 동기화를 모두
먼저 멈춘다. Organizer가 inactive인지 확인하고 새 백업을 만든 뒤 정확한 transaction ID를
사용한다. 아래 `ORG-EXAMPLE-IDENTIFIER`는 예시이며 실제 ID가 아니므로 그대로 실행하면 안
된다. Undo 후 audit 결과가 깨끗한지 확인하기 전에는 서비스를 다시 열지 않는다.

```bash
set -euo pipefail
sudo systemctl stop brain-organizer.timer brain-organizer.service brain-mcp brain-syncthing
sudo systemctl reset-failed brain-organizer.service
sudo systemctl show --property=ActiveState --value brain-organizer.service | grep -qx inactive
sudo systemctl show --property=ActiveState --value brain-organizer.timer | grep -qx inactive
sudo /usr/local/sbin/brain-mcp-backup
sudo -u brain env MCP_CONFIG_FILE=/etc/brain-mcp-config.json \
  /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js undo --vault brain \
  --transaction ORG-EXAMPLE-IDENTIFIER
brain_audit=$(
  sudo -u brain env MCP_CONFIG_FILE=/etc/brain-mcp-config.json \
    /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js audit --vault brain
)
printf '%s\n' "$brain_audit" | jq -e '.findings | length == 0'
sudo systemctl start brain-syncthing brain-mcp
sudo systemctl is-active brain-syncthing brain-mcp
sudo systemctl is-enabled brain-organizer.timer
sudo systemctl show --property=ActiveState --value brain-organizer.timer | grep -qx inactive
```

모든 앞 단계가 성공한 뒤에만 Syncthing과 MCP를 다시 시작한다. Timer는 enable 상태만
확인하고 이 세션에서는 시작하지 않는다.

## PC와 서버 연결

서버의 Syncthing 관리 화면은 인터넷에 공개하지 않는다. PC에서 다음 SSH 터널을 켠 동안에만 `http://127.0.0.1:9090`으로 연다.

```powershell
ssh -N -L 9090:127.0.0.1:8384 -i .\work\keys\brain-mcp-oracle.key ubuntu@SERVER_IP
```

서버 장치 ID는 서버의 `/root/brain-syncthing-device-id.txt`에 있다. PC에 새 빈 폴더를 만들고 Obsidian에서 **Open folder as vault**로 연 뒤, PC Syncthing과 서버에서 서로의 장치 ID를 추가한다.

| 폴더 ID | 서버 폴더 | PC 폴더 예시 |
|---|---|---|
| `brain` | `/srv/brain/vaults/brain` | 새로 만든 `Brain` Vault 폴더 |

새 폴더 ID `brain`만 공유한다. 서버에서 만들어진 `Agent-Inbox` 노트는 PC·Android의 새 `Brain` Vault에 내려오고, 그 Vault에서 작성한 노트만 서버에 올라간다. 기존 Obsidian Vault는 공유 대상으로 선택하지 않는다. Android에서도 새 `Brain` 폴더만 Obsidian Vault로 연다.

각 PC·Android Vault의 Syncthing 무시 패턴에도 다음을 넣어 창 배치 충돌을 피한다.

```text
(?d).obsidian/workspace.json
(?d).obsidian/workspace-mobile.json
(?d).obsidian/cache
(?d).trash
(?d).DS_Store
(?d)Thumbs.db
```

서버에는 원격 변경의 이전 버전을 90일간 보관하는 `Staggered File Versioning`이 자동 설정된다. `.stversions`는 Obsidian에서 Vault로 열지 않는다.

## 백업과 복구

```bash
sudo /usr/local/sbin/brain-mcp-backup
sudo find /srv/brain/backups -maxdepth 2 -type f -ls
sudo tar -tzf "$(sudo find /srv/brain/backups -name vaults.tgz | sort | tail -1)"
```

로컬 백업은 14일 보관한다. VM 자체 손실에 대비하려면 Oracle 콘솔에서 부트 볼륨 백업 정책도 별도로 연결한다.

SQLite 검색 DB는 Markdown에서 다시 만들 수 있다. 서비스 중지 후 `/srv/brain/data/index.sqlite*`를 안전한 별도 이름으로 옮기고 서비스를 시작하면 자동 재구축된다.
