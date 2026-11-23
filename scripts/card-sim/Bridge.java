// SPDX-FileCopyrightText: 2026 QuantX
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Line-oriented multi-card APDU bridge over org.qntx.card.sim.Card, running the real qntx card
// applet (AGPL-3.0-or-later) in its patched jcardsim. The bridge links the applet only at test
// time, inside this JVM; it is never shipped.
//
// Wire protocol — one ASCII request line on stdin, one response line on stdout:
//
//   (start)            -> READY                     bridge is up; no card exists yet
//   new                -> CARD <n> <cert hex>       fresh card n = 0,1,2,...: installed, selected
//                                                  and personalised under test CA ca1
//                                                  (spec/vectors/cert.json), left in BLANK state,
//                                                  then power-cycled — the client must SELECT
//   apdu <n> <hex>     -> R <hex> | TORN | ERR <m>  raw C-APDU; R is data‖SW lowercase, TORN the
//                                                  armed tear fired (card needs reset + SELECT)
//   tear <n> <k>       -> OK                        Card.tearAt(k): tear on the k-th persistent
//                                                  write of a later command on card n
//   reset <n>          -> OK                        Card.powerCycle()
//
// ERR <m> is any other failure (bad request shape, unknown card, exception; <m> has no newlines).
// EOF exits. Fault injection (Fault.arm*) is JVM-global in the simulator, not per card, so the
// protocol exposes no fault command; only the per-card tear point is wired up.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.math.BigInteger;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import org.qntx.card.WalletApplet;
import org.qntx.card.host.Certificates;
import org.qntx.card.sim.Card;
import org.qntx.card.sim.TornException;

public final class Bridge {

    private static final HexFormat HEX = HexFormat.of();
    private static final byte[] WALLET_AID = HEX.parseHex("F0716E74780101");
    private static final byte[] SELECT = HEX.parseHex("00A4040007F0716E7478010100");
    private static final byte[] GET_IDENTITY = HEX.parseHex("80E0000000");

    // spec/vectors/cert.json ca1: the batch CA the test cards personalize under.
    private static final BigInteger CA1_PRIVATE =
            new BigInteger(
                    "a76d852de566723ec4e6414f49b80dd3899ef7661b9afc4e6dac489adcba69a7", 16);
    private static final byte[] CA1_PUBLIC =
            HEX.parseHex(
                    "04326ee50a70d17883e337bad61f8075e1510904110ca189423cb4fa3c7ae24d69bb49ba03e8e46321cadeee736ddc1fd1bcb0bc3dad5fdd598dd1a87c31b63f22");

    private final List<Card> cards = new ArrayList<>();
    private final PrintStream out;

    private Bridge(PrintStream out) {
        this.out = out;
    }

    public static void main(String[] args) throws Exception {
        // jcardsim logs to System.out; sink it so the bridge keeps the wire clean.
        PrintStream out = System.out;
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));

        Bridge bridge = new Bridge(out);
        if (args.length == 2 && args[0].equals("--tcp")) {
            // Same protocol over one TCP connection — one client; disconnecting exits.
            try (ServerSocket server = new ServerSocket(Integer.parseInt(args[1]));
                    Socket socket = server.accept();
                    PrintStream remote =
                            new PrintStream(socket.getOutputStream(), true, StandardCharsets.UTF_8);
                    BufferedReader in =
                            new BufferedReader(
                                    new InputStreamReader(
                                            socket.getInputStream(), StandardCharsets.UTF_8))) {
                remote.println("READY");
                String line;
                while ((line = in.readLine()) != null) {
                    remote.println(bridge.answer(line.trim()));
                }
            }
            return;
        }
        if (args.length != 0) {
            out.println("ERR usage: Bridge [--tcp <port>]");
            out.flush();
            return;
        }

        out.println("READY");
        out.flush();

        BufferedReader in =
                new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            out.println(bridge.answer(line.trim()));
            out.flush();
        }
    }

    private String answer(String line) {
        try {
            String[] parts = line.split(" ");
            if (parts.length == 1 && parts[0].equals("new")) {
                return newCard();
            }
            if (parts.length == 3 && parts[0].equals("apdu")) {
                return transmit(card(parts[1]), parts[2]);
            }
            if (parts.length == 3 && parts[0].equals("tear")) {
                card(parts[1]).tearAt(Integer.parseInt(parts[2]));
                return "OK";
            }
            if (parts.length == 2 && parts[0].equals("reset")) {
                card(parts[1]).powerCycle();
                return "OK";
            }
            return "ERR bad request: " + line;
        } catch (Exception e) {
            String message = String.valueOf(e).replace('\n', ' ').replace('\r', ' ');
            return "ERR " + message;
        }
    }

    private Card card(String index) {
        int n = Integer.parseInt(index);
        if (n < 0 || n >= cards.size()) {
            throw new IllegalArgumentException("unknown card " + n);
        }
        return cards.get(n);
    }

    /** FACTORY → GET_IDENTITY → cert under ca1 → PERSONALIZE → power cycle; BLANK afterwards. */
    private String newCard() {
        Card card = new Card();
        cards.add(card);
        card.install(WALLET_AID, WalletApplet.class);
        check(card.transmit(SELECT), "SELECT");

        // FACTORY: the card generates its own identity; GET_IDENTITY returns A (33 B).
        byte[] idr = card.transmit(GET_IDENTITY);
        check(idr, "GET_IDENTITY");
        byte[] a = Arrays.copyOf(idr, 33);

        // cert = A || Sign(ca1, "qntx-card/v1/cert" || A); PERSONALIZE takes cert || CA1 public.
        byte[] cert = Certificates.issue(CA1_PRIVATE, a);
        byte[] personalize = new byte[5 + 162];
        personalize[0] = (byte) 0x80;
        personalize[1] = (byte) 0xE2;
        personalize[4] = (byte) 162;
        System.arraycopy(cert, 0, personalize, 5, 97);
        System.arraycopy(CA1_PUBLIC, 0, personalize, 102, 65);
        check(card.transmit(personalize), "PERSONALIZE");

        card.powerCycle();
        return "CARD " + (cards.size() - 1) + " " + HEX.formatHex(cert);
    }

    private String transmit(Card card, String hexApdu) {
        try {
            return "R " + HEX.formatHex(card.transmit(HEX.parseHex(hexApdu)));
        } catch (TornException torn) {
            return "TORN";
        }
    }

    private static void check(byte[] rapdu, String what) {
        int n = rapdu.length;
        int sw = ((rapdu[n - 2] & 0xFF) << 8) | (rapdu[n - 1] & 0xFF);
        if (sw != 0x9000) {
            throw new IllegalStateException(what + " failed: " + Integer.toHexString(sw));
        }
    }
}
