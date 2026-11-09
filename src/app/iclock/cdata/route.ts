/**
 * /iclock/cdata — Native ZKTeco / eSSL / BioTime ADMS Push Endpoint
 * Physical terminals only allow entering Server IP/Domain + Port on the keypad
 * and hardcode the path `/iclock/cdata` for handshakes (GET) and ATTLOG pushes (POST).
 */
export { GET, POST } from "@/app/api/biometrics/push/route";
