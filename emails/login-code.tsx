import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from '@react-email/components';

/**
 * The sign-in code mail. Values the service substitutes are written as
 * {{name}} markers: the build renders this file once to static HTML, and the
 * Go and Node services fill the markers, so both send the same message.
 */
export default function LoginCode() {
  return (
    <Html lang="fr">
      <Head />
      <Preview>Votre code de connexion Blok : {'{{code}}'}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>Votre code de connexion</Heading>
          <Text style={paragraph}>
            Saisissez ce code pour vous connecter. Il expire dans dix minutes.
          </Text>
          <Section style={codeBox}>
            <Text style={code}>{'{{code}}'}</Text>
          </Section>
          <Text style={paragraph}>
            Si vous n’avez pas demandé ce code, ignorez cet e-mail : personne ne
            peut se connecter sans lui.
          </Text>
          <Hr style={rule} />
          <Text style={footer}>{'{{publicURL}}'}</Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: '#f6f6f7', margin: 0, padding: '32px 0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' };
const container = { backgroundColor: '#ffffff', border: '1px solid #e8e8ea', borderRadius: '10px', margin: '0 auto', maxWidth: '456px', padding: '36px 40px' };
const heading = { color: '#1a1a1a', fontSize: '21px', fontWeight: 600, lineHeight: '28px', margin: '0 0 18px' };
const paragraph = { color: '#4a4a4f', fontSize: '15px', lineHeight: '24px', margin: '0 0 18px' };
const codeBox = { backgroundColor: '#f6f6f7', borderRadius: '8px', margin: '0 0 22px', padding: '18px 0', textAlign: 'center' as const };
const code = { color: '#1a1a1a', fontSize: '30px', fontWeight: 700, letterSpacing: '7px', lineHeight: '36px', margin: 0 };
const rule = { borderColor: '#e8e8ea', margin: '26px 0 16px' };
const footer = { color: '#8a8a90', fontSize: '13px', lineHeight: '18px', margin: 0 };
