// The iOS NFC reader: NFCTagReaderSession wrapped as a CardReader. The kernel
// sets the panel's alertMessage once at open; APDUs flow only between the
// kernel and this file. Delegate callbacks run on a private serial queue, so
// every piece of state is touched from that queue only. Nothing here logs a
// prompt, an APDU or a response.
#include "../host/CardReader.hpp"

#import <CoreNFC/CoreNFC.h>
#import <Foundation/Foundation.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

qntx::CardReaderStatus statusOf(NFCReaderError code) {
  switch (code) {
    case NFCReaderSessionInvalidationErrorUserCanceled:
      return qntx::CardReaderStatus::cancelled;
    case NFCReaderSessionInvalidationErrorSessionTimeout:
      return qntx::CardReaderStatus::timeout;
    case NFCReaderSessionInvalidationErrorSessionTerminatedUnexpectedly:
      return qntx::CardReaderStatus::interrupted;
    case NFCReaderSessionInvalidationErrorSystemIsBusy:
      return qntx::CardReaderStatus::unavailable;
    case NFCReaderTransceiveErrorTagConnectionLost:
    case NFCReaderTransceiveErrorRetryExceeded:
    case NFCReaderTransceiveErrorTagResponseError:
    case NFCReaderTransceiveErrorTagNotConnected:
      return qntx::CardReaderStatus::tagLost;
    case NFCReaderTransceiveErrorSessionInvalidated:
      // Our own invalidateSession; anything that reaches a caller here is
      // already dropped by the kernel, so the mapped code only matters for
      // the remembered session-end answer.
      return qntx::CardReaderStatus::interrupted;
    default:
      return qntx::CardReaderStatus::unavailable;
  }
}

qntx::CardReaderResult resultOf(NSError* error) {
  const auto status = statusOf(static_cast<NFCReaderError>(error.code));
  return {status,
          {},
          std::string("NFCError:") + std::to_string(static_cast<long long>(error.code))};
}

NSString* nsString(const std::string& text) {
  return [[NSString alloc] initWithBytes:text.data()
                                length:text.size()
                              encoding:NSUTF8StringEncoding];
}

} // namespace

// Everything below runs on `_queue`, the private serial queue the session's
// delegate callbacks are delivered on — no locks needed.
@interface QntxNfcSession : NSObject <NFCTagReaderSessionDelegate>

- (instancetype)init;
- (void)openWithPrompt:(std::string)prompt done:(qntx::CardReaderDone)done;
- (void)transmitApdu:(std::vector<uint8_t>)apdu done:(qntx::CardReaderDone)done;
- (void)closeWithSuccess:(BOOL)success text:(std::string)text;

@end

@implementation QntxNfcSession {
  dispatch_queue_t _queue;
  NFCTagReaderSession* _session;
  // A session close() invalidated that has not delivered didInvalidate yet —
  // its delegate events must never touch `_session`, which may already be a
  // newer session.
  NFCTagReaderSession* _closing;
  id<NFCISO7816Tag> _isoTag;
  qntx::CardReaderDone _openDone;
  qntx::CardReaderDone _txDone;
  // A session is reusable only after didInvalidate arrived; an open that
  // arrives before that waits here.
  std::optional<std::pair<std::string, qntx::CardReaderDone>> _queuedOpen;
  // A session-ending event with no in-flight call fails the next transmit.
  std::optional<qntx::CardReaderResult> _ended;
}

- (instancetype)init {
  if (self = [super init]) {
    _queue = dispatch_queue_create("org.qntx.wallet.nfc", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)failAll:(qntx::CardReaderResult)result {
  _ended = result;
  auto openDone = std::move(_openDone);
  _openDone = nullptr;
  auto txDone = std::move(_txDone);
  _txDone = nullptr;
  if (openDone != nullptr) {
    openDone(result);
  }
  if (txDone != nullptr) {
    txDone(result);
  }
}

- (void)openWithPrompt:(std::string)prompt done:(qntx::CardReaderDone)done {
  dispatch_async(_queue, ^{
    if (!NFCTagReaderSession.readingAvailable) {
      done({qntx::CardReaderStatus::unavailable, {}, "ios:nfc-unavailable"});
      return;
    }
    if (_queuedOpen.has_value()) {
      // A contract violation: the kernel serializes opens, so this never
      // fires — but the completion contract still must be kept.
      done({qntx::CardReaderStatus::unavailable, {}, "ios:busy"});
      return;
    }
    if (_session != nil || _closing != nil) {
      // didInvalidate has not arrived yet: a session cannot be reused or
      // re-begun until it does (I8). Hold the open.
      _queuedOpen = std::make_pair(std::move(prompt), std::move(done));
      return;
    }
    [self beginWithPrompt:std::move(prompt) done:std::move(done)];
  });
}

- (void)beginWithPrompt:(std::string)prompt done:(qntx::CardReaderDone)done {
  _ended = std::nullopt;
  _isoTag = nil;
  _openDone = std::move(done);
  _session = [[NFCTagReaderSession alloc]
      initWithPollingOption:NFCPollingISO14443
                   delegate:self
                      queue:_queue];
  // The panel measures its label height once at begin (I1, I11): set the
  // trusted text first and never rewrite it mid-session.
  _session.alertMessage = nsString(prompt);
  [_session beginSession];
}

- (void)transmitApdu:(std::vector<uint8_t>)apdu done:(qntx::CardReaderDone)done {
  dispatch_async(_queue, ^{
    if (_session == nil || _isoTag == nil) {
      done(_ended.value_or(
          qntx::CardReaderResult{qntx::CardReaderStatus::unavailable, {}, {}}));
      return;
    }
    if (_txDone != nullptr) {
      done({qntx::CardReaderStatus::unavailable, {}, "ios:busy"});
      return;
    }
    NSData* data = [NSData dataWithBytes:apdu.data() length:apdu.size()];
    NFCISO7816APDU* command = [[NFCISO7816APDU alloc] initWithData:data];
    if (command == nil) {
      done({qntx::CardReaderStatus::unavailable, {}, "qntx:bad-apdu"});
      return;
    }
    _txDone = std::move(done);
    NFCTagReaderSession* session = _session;
    id<NFCISO7816Tag> isoTag = _isoTag;
    [isoTag sendCommandAPDU:command
         completionHandler:^(NSData* _Nullable data, uint8_t sw1, uint8_t sw2,
                             NSError* _Nullable error) {
           if (session != _session) {
             // The call belonged to a session that close() already moved
             // aside — its done was completed cancelled there.
             return;
           }
           auto txDone = std::move(_txDone);
           _txDone = nullptr;
           if (error != nil) {
             // Every failure ends the session, silently.
             auto result = resultOf(error);
             [_session invalidateSession];
             _isoTag = nil;
             _ended = result;
             txDone(result);
             return;
           }
           std::vector<uint8_t> response(
               static_cast<const uint8_t*>(data.bytes),
               static_cast<const uint8_t*>(data.bytes) + data.length);
           response.push_back(sw1);
           response.push_back(sw2);
           txDone({qntx::CardReaderStatus::ok, std::move(response), {}});
         }];
  });
}

- (void)closeWithSuccess:(BOOL)success text:(std::string)text {
  dispatch_async(_queue, ^{
    auto queued = std::move(_queuedOpen);
    _queuedOpen = std::nullopt;
    if (queued.has_value() && queued->second != nullptr) {
      queued->second({qntx::CardReaderStatus::cancelled, {}, {}});
    }
    // Anything still in flight on the closing session is cancelled now —
    // its didInvalidate later must not complete a newer session's calls.
    auto openDone = std::move(_openDone);
    _openDone = nullptr;
    auto txDone = std::move(_txDone);
    _txDone = nullptr;
    const qntx::CardReaderResult cancelled{qntx::CardReaderStatus::cancelled, {}, {}};
    if (openDone != nullptr) {
      openDone(cancelled);
    }
    if (txDone != nullptr) {
      txDone(cancelled);
    }
    if (_session == nil) {
      return;
    }
    if (success && !text.empty()) {
      _session.alertMessage = nsString(text);
      [_session invalidateSession];
    } else if (!success && !text.empty()) {
      [_session invalidateSessionWithErrorMessage:nsString(text)];
    } else {
      [_session invalidateSession];
    }
    // Keep the invalidated session: its didInvalidate still has to arrive
    // and must be told apart from a newer session's events.
    _closing = _session;
    _session = nil;
    _isoTag = nil;
  });
}

- (void)tagReaderSession:(NFCTagReaderSession*)session
    didDetectTags:(NSArray<id<NFCTag>>*)tags {
  if (session != _session) {
    return;
  }
  if (_openDone == nullptr || tags.count != 1 ||
      tags.firstObject.type != NFCTagTypeISO7816Compatible) {
    // Anything that is not exactly one ISO-DEP tag: keep polling without
    // touching the panel text.
    [session restartPolling];
    return;
  }
  id<NFCTag> tag = tags.firstObject;
  [session connectToTag:tag
      completionHandler:^(NSError* _Nullable error) {
        if (session != _session) {
          return;
        }
        if (error != nil) {
          auto result = resultOf(error);
          [_session invalidateSession];
          _isoTag = nil;
          _ended = result;
          auto openDone = std::move(_openDone);
          _openDone = nullptr;
          openDone(result);
          return;
        }
        _isoTag = (id<NFCISO7816Tag>)tag;
        auto openDone = std::move(_openDone);
        _openDone = nullptr;
        openDone({qntx::CardReaderStatus::ok, {}, {}});
      }];
}

- (void)tagReaderSession:(NFCTagReaderSession*)session
    didInvalidateWithError:(NSError*)error {
  if (session == _closing) {
    // The session close() invalidated delivered its final event: it may
    // now be replaced.
    _closing = nil;
  } else if (session == _session) {
    _session = nil;
    _isoTag = nil;
    [self failAll:resultOf(error)];
  } else {
    // A session older than _closing: nothing live refers to it.
    return;
  }
  if (_queuedOpen.has_value() && _session == nil && _closing == nil) {
    auto queued = std::move(_queuedOpen);
    _queuedOpen = std::nullopt;
    [self beginWithPrompt:std::move(queued->first) done:std::move(queued->second)];
  }
}

@end

namespace qntx {
namespace {

class IosCardReader final : public CardReader {
 public:
  void open(std::string prompt, CardReaderDone done) override {
    [_session openWithPrompt:std::move(prompt) done:std::move(done)];
  }

  void transmit(std::vector<uint8_t> apdu, CardReaderDone done) override {
    [_session transmitApdu:std::move(apdu) done:std::move(done)];
  }

  void close(bool success, std::string text) override {
    [_session closeWithSuccess:success ? YES : NO text:std::move(text)];
  }

 private:
  QntxNfcSession* _session = [[QntxNfcSession alloc] init];
};

} // namespace

std::shared_ptr<CardReader> platformCardReader() {
  static const auto reader = std::make_shared<IosCardReader>();
  return reader;
}

} // namespace qntx
