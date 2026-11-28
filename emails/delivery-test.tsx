import { Body, Container, Head, Heading, Html, Preview, Text } from '@react-email/components';

/** The "does mail work" probe sent from the admin and setup screens. */
export default function DeliveryTest() {
  return (
    <Html lang="fr">
      <Head />
      <Preview>La livraison des e-mails Blok fonctionne</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>La livraison fonctionne</Heading>
          <Text style={paragraph}>
            Ceci est un e-mail de test envoyé depuis {'{{publicURL}}'}. Si vous
            le recevez, votre configuration d’envoi est correcte.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: '#f6f6f7', margin: 0, padding: '32px 0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' };
const container = { backgroundColor: '#ffffff', border: '1px solid #e8e8ea', borderRadius: '10px', margin: '0 auto', maxWidth: '456px', padding: '36px 40px' };
const heading = { color: '#1a1a1a', fontSize: '21px', fontWeight: 600, lineHeight: '28px', margin: '0 0 18px' };
const paragraph = { color: '#4a4a4f', fontSize: '15px', lineHeight: '24px', margin: 0 };
