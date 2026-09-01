# Oracle 배포 및 Obsidian 동기화

이 배포는 한 Oracle Ubuntu VM에서 다음 세 가지를 함께 실행한다.

- `brain-mcp`: 여러 Obsidian Vault를 검색하는 OAuth 보호 MCP 서버
- `brain-syncthing`: PC·Android와 Vault Markdown 파일을 양방향 동기화
- `caddy`: 공개 HTTPS 주소와 인증서

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
