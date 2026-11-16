import "./globals.css";

export const metadata = {
  title: "LitPeer",
  description: "Cited answers from biology, healthcare and drug discovery literature",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
