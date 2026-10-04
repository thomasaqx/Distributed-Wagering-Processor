import { type CanActivate, Injectable } from "@nestjs/common";

/**
 * Authentication extension point. Intentionally a no-op: authentication is out of scope for this
 * challenge (see ARCHITECTURE.md). The intended design validates an OIDC access token issued by an
 * external IdP (e.g. Keycloak, client-credentials per provider) and checks that the token's
 * provider matches `providerId` in the request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
