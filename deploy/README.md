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

```bash
sudo systemctl start brain-organizer.service
sudo systemctl status brain-organizer.service --no-pager
```

`sudo systemctl edit --runtime brain-organizer.timer`는 수정 사항과 독립 재검토가 모두 끝난
후의 제한된 trial 일정 조정용으로만 예약한다. 현재 차단 상태에서는 실행하거나 runtime
override를 만들지 않는다. `DEPLOY_EXPECT_ORGANIZER=1`도 13개 tool 배포를 승인하는 스위치가
아니며, 차단 해제 후 이미 승인된 13개 surface를 검증할 때만 사용할 수 있다.

### 긴급 비활성화

향후 승인된 trial 중 문제가 생기면 protected environment를 열어
`ORGANIZER_PROVIDER=disabled`로 바꾼 뒤 MCP만 재시작한다. key 값은 명령줄, 로그, 문서에
복사하지 않는다. Timer는 켜 두어도 provider가 없으므로 실제 정리를 수행하지 않는다.

```bash
sudoedit /etc/brain-organizer.env
sudo grep -qx 'ORGANIZER_PROVIDER=disabled' /etc/brain-organizer.env
sudo chown root:brain /etc/brain-organizer.env
sudo chmod 0640 /etc/brain-organizer.env
sudo systemctl restart brain-mcp
sudo systemctl reset-failed brain-organizer.service
sudo systemctl is-active brain-mcp brain-organizer.timer
```

### Guarded undo

기존 transaction을 복구할 때만 writer와 동기화를 먼저 멈추고 새 백업을 만든 뒤 정확한
transaction ID를 사용한다. 아래 `ORG-EXAMPLE-IDENTIFIER`는 예시이며 실제 ID가 아니므로
그대로 실행하면 안 된다. Undo 후 audit이 끝나기 전에는 서비스를 다시 열지 않는다.

```bash
sudo systemctl stop brain-organizer.timer brain-mcp brain-syncthing
sudo /usr/local/sbin/brain-mcp-backup
sudo -u brain env MCP_CONFIG_FILE=/etc/brain-mcp-config.json \
  /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js undo --vault brain \
  --transaction ORG-EXAMPLE-IDENTIFIER
sudo -u brain env MCP_CONFIG_FILE=/etc/brain-mcp-config.json \
  /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js audit --vault brain
sudo systemctl start brain-syncthing brain-mcp brain-organizer.timer
```

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
