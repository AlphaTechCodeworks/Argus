// Hikvision HCNetSDK (Device Network SDK) V6.1.11.40, Linux 64-bit: the structures, constants and
// error codes Argus uses, transcribed from incEn/HCNetSDK.h of that SDK (line numbers below). Pure:
// nothing here loads koffi or the library, so it is tested on any machine.
//
// On Linux the header makes LONG, BOOL and DWORD 32-bit (HCNetSDK.h 35-48: `typedef int LONG`,
// `#define BOOL int`, `typedef unsigned int DWORD`) and HWND an `unsigned int` (line 72), and it has
// no #pragma pack: every structure has the platform's natural alignment. LAYOUT holds each structure's
// size and the offsets Argus reads or writes, worked out by hand from the header; the tests check
// them against koffi's own layout of defineHikTypes() below (the same fields, in header order), and the
// header comment "cbLoginResultV40 ... (offset 296)" (line 32307) is checked as well.
//
// Structures are filled and read as Buffers at these offsets (hik-sdk.mjs passes them as void *), so a
// wrong offset would be a wrong number, never a write past the end: every Buffer is LAYOUT.size long.

// ---- constants -------------------------------------------------------------------------------------

/** NET_DVR_GET_IPPARACFG_V40 (HCNetSDK.h 2480): the IP channels of an NVR, NET_DVR_IPPARACFG_V40. */
export const NET_DVR_GET_IPPARACFG_V40 = 1062
/** NET_DVR_GET_DEVICECFG_V40 (HCNetSDK.h 2533): the device's name, model name and serial, NET_DVR_DEVICECFG_V40. */
export const NET_DVR_GET_DEVICECFG_V40 = 1100
/** NET_SDK_INIT_CFG_TYPE (HCNetSDK.h 49301-49310), for NET_DVR_SetSDKInitCfg before NET_DVR_Init. */
export const INIT_CFG = { SDK_PATH: 2, LIBEAY_PATH: 3, SSLEAY_PATH: 4 }
/**
 * NET_SDK_LOCAL_CFG_TYPE (HCNetSDK.h 32010-32043), counted from TCP_PORT_BIND = 0: P2P_LOGIN_2C is the
 * 24th member. Only the P2P ones are used. The developer guide does not describe them.
 */
export const LOCAL_CFG = { P2P_LOGIN_2C: 23, P2P_LOGIN_2B: 24, P2P_LOGOUT: 25 }
/** The member names of NET_SDK_LOCAL_CFG_TYPE up to P2P_LOGOUT, in order (checked against the header). */
export const LOCAL_CFG_ORDER = [
  'NET_SDK_LOCAL_CFG_TYPE_TCP_PORT_BIND', 'NET_SDK_LOCAL_CFG_TYPE_UDP_PORT_BIND', 'NET_SDK_LOCAL_CFG_TYPE_MEM_POOL',
  'NET_SDK_LOCAL_CFG_TYPE_MODULE_RECV_TIMEOUT', 'NET_SDK_LOCAL_CFG_TYPE_ABILITY_PARSE', 'NET_SDK_LOCAL_CFG_TYPE_TALK_MODE',
  'NET_SDK_LOCAL_CFG_TYPE_PROTECT_KEY', 'NET_SDK_LOCAL_CFG_TYPE_CFG_VERSION', 'NET_SDK_LOCAL_CFG_TYPE_RTSP_PARAMS',
  'NET_SDK_LOCAL_CFG_TYPE_SIMXML_LOGIN', 'NET_SDK_LOCAL_CFG_TYPE_CHECK_DEV', 'NET_SDK_LOCAL_CFG_TYPE_SECURITY',
  'NET_SDK_LOCAL_CFG_TYPE_EZVIZLIB_PATH', 'NET_SDK_LOCAL_CFG_TYPE_CHAR_ENCODE', 'NET_SDK_LOCAL_CFG_TYPE_PROXYS',
  'NET_DVR_LOCAL_CFG_TYPE_LOG', 'NET_DVR_LOCAL_CFG_TYPE_STREAM_CALLBACK', 'NET_DVR_LOCAL_CFG_TYPE_GENERAL',
  'NET_DVR_LOCAL_CFG_TYPE_PTZ', 'NET_DVR_LOCAL_CFG_MESSAGE_CALLBACK_V51', 'NET_SDK_LOCAL_CFG_CERTIFICATION',
  'NET_SDK_LOCAL_CFG_PORT_MULTIPLEX', 'NET_SDK_LOCAL_CFG_ASYNC', 'NET_SDK_P2P_LOGIN_2C', 'NET_SDK_P2P_LOGIN_2B', 'NET_SDK_P2P_LOGOUT'
]
/** dwPacketType of NET_DVR_PACKET_INFO_EX (HCNetSDK.h 47567): 0 file head, 1 I, 2 B, 3 P, 10 audio, 11 private. */
export const PACKET = { HEAD: 0, I: 1, B: 2, P: 3, AUDIO: 10, PRIVATE: 11 }
/** NET_DVR_SetLogToFile levels (developer guide 12.7.7): 1 = errors only. */
export const LOG_ERRORS_ONLY = 1
/** Default private-protocol (SDK) port of a Hikvision device. */
export const HIK_DEFAULT_PORT = 8000
/** Most channels read: NET_DVR_IPPARACFG_V40 describes one group of MAX_CHANNUM_V30 = 64 (HCNetSDK.h 345). */
export const MAX_IP_CHANNELS = 64

// ---- layouts (offsets in bytes, Linux x86-64) ------------------------------------------------------

/** [offset, kind, count?]; kinds: u8 u16 u32 i32 ptr char (count bytes) bytes (count bytes) */
export const LAYOUT = {
  // HCNetSDK.h 9435-9439
  NET_DVR_IPADDR: { size: 144, align: 1, fields: { sIpV4: [0, 'char', 16], byIPv6: [16, 'bytes', 128] } },
  // HCNetSDK.h 32315-32339 (the 64-bit branch: OS_POSIX64 is set by __LP64__, lines 15-17)
  NET_DVR_USER_LOGIN_INFO: {
    size: 416, align: 8,
    fields: {
      sDeviceAddress: [0, 'char', 129], byUseTransport: [129, 'u8'], wPort: [130, 'u16'], sUserName: [132, 'char', 64],
      sPassword: [196, 'char', 64], cbLoginResult: [264, 'ptr'], pUser: [272, 'ptr'], bUseAsynLogin: [280, 'i32'],
      byProxyType: [284, 'u8'], byUseUTCTime: [285, 'u8'], byLoginMode: [286, 'u8'], byHttps: [287, 'u8'],
      iProxyID: [288, 'i32'], byVerifyMode: [292, 'u8'], byRes1: [293, 'bytes', 3], cbLoginResultV40: [296, 'ptr'],
      byRes3: [304, 'bytes', 109]
    }
  },
  // HCNetSDK.h 13754-13826
  NET_DVR_DEVICEINFO_V30: {
    size: 80, align: 2,
    fields: {
      sSerialNumber: [0, 'char', 48], byAlarmInPortNum: [48, 'u8'], byAlarmOutPortNum: [49, 'u8'], byDiskNum: [50, 'u8'],
      byDVRType: [51, 'u8'], byChanNum: [52, 'u8'], byStartChan: [53, 'u8'], byAudioChanNum: [54, 'u8'], byIPChanNum: [55, 'u8'],
      byZeroChanNum: [56, 'u8'], byMainProto: [57, 'u8'], bySubProto: [58, 'u8'], bySupport: [59, 'u8'], bySupport1: [60, 'u8'],
      bySupport2: [61, 'u8'], wDevType: [62, 'u16'], bySupport3: [64, 'u8'], byMultiStreamProto: [65, 'u8'], byStartDChan: [66, 'u8'],
      byStartDTalkChan: [67, 'u8'], byHighDChanNum: [68, 'u8'], bySupport4: [69, 'u8'], byLanguageType: [70, 'u8'],
      byVoiceInChanNum: [71, 'u8'], byStartVoiceInChanNo: [72, 'u8'], bySupport5: [73, 'u8'], bySupport6: [74, 'u8'],
      byMirrorChanNum: [75, 'u8'], wStartMirrorChanNo: [76, 'u16'], bySupport7: [78, 'u8'], byRes2: [79, 'u8']
    }
  },
  // HCNetSDK.h 13828-13859
  NET_DVR_DEVICEINFO_V40: {
    size: 344, align: 4,
    fields: {
      struDeviceV30: [0, 'bytes', 80], bySupportLock: [80, 'u8'], byRetryLoginTime: [81, 'u8'], byPasswordLevel: [82, 'u8'],
      byProxyType: [83, 'u8'], dwSurplusLockTime: [84, 'u32'], byCharEncodeType: [88, 'u8'], bySupportDev5: [89, 'u8'],
      bySupport: [90, 'u8'], byLoginMode: [91, 'u8'], dwOEMCode: [92, 'u32'], iResidualValidity: [96, 'i32'],
      byResidualValidity: [100, 'u8'], bySingleStartDTalkChan: [101, 'u8'], bySingleDTalkChanNums: [102, 'u8'],
      byPassWordResetLevel: [103, 'u8'], bySupportStreamEncrypt: [104, 'u8'], byMarketType: [105, 'u8'], byTLSCap: [106, 'u8'],
      byChildManage: [107, 'u8'], byPlaybackNewPosCap: [108, 'u8'], bySecondaryAuth: [109, 'u8'], byHttpsResult: [110, 'u8'],
      byRes2: [111, 'bytes', 233]
    }
  },
  // HCNetSDK.h 22238-22301 (NAME_LEN 32, SERIALNO_LEN 48, DEV_TYPE_NAME_LEN 24: lines 102, 109, 108)
  NET_DVR_DEVICECFG_V40: {
    size: 180, align: 4,
    fields: {
      dwSize: [0, 'u32'], sDVRName: [4, 'char', 32], dwDVRID: [36, 'u32'], dwRecycleRecord: [40, 'u32'], sSerialNumber: [44, 'char', 48],
      dwSoftwareVersion: [92, 'u32'], dwSoftwareBuildDate: [96, 'u32'], byChanNum: [124, 'u8'], byStartChan: [125, 'u8'],
      byIPChanNum: [131, 'u8'], wDevType: [138, 'u16'], byDevTypeName: [140, 'char', 24], bySupport2: [164, 'u8'],
      byHighIPChanNum: [170, 'u8'], wDevClass: [172, 'u16'], byRes2: [174, 'bytes', 6]
    }
  },
  // HCNetSDK.h 13910-13929 (hPlayWnd: HWND, an unsigned int on Linux)
  NET_DVR_PREVIEWINFO: {
    size: 280, align: 4,
    fields: {
      lChannel: [0, 'i32'], dwStreamType: [4, 'u32'], dwLinkMode: [8, 'u32'], hPlayWnd: [12, 'u32'], bBlocked: [16, 'u32'],
      bPassbackRecord: [20, 'u32'], byPreviewMode: [24, 'u8'], byStreamID: [25, 'bytes', 32], byProtoType: [57, 'u8'],
      byRes1: [58, 'u8'], byVideoCodingType: [59, 'u8'], dwDisplayBufNum: [60, 'u32'], byNPQMode: [64, 'u8'],
      byRecvMetaData: [65, 'u8'], byDataType: [66, 'u8'], byReconnect: [67, 'u8'], byRes: [68, 'bytes', 212]
    }
  },
  // HCNetSDK.h 47550-47579
  NET_DVR_PACKET_INFO_EX: {
    size: 120, align: 8,
    fields: {
      wWidth: [0, 'u16'], wHeight: [2, 'u16'], dwTimeStamp: [4, 'u32'], dwTimeStampHigh: [8, 'u32'], dwYear: [12, 'u32'],
      dwMonth: [16, 'u32'], dwDay: [20, 'u32'], dwHour: [24, 'u32'], dwMinute: [28, 'u32'], dwSecond: [32, 'u32'],
      dwMillisecond: [36, 'u32'], dwFrameNum: [40, 'u32'], dwFrameRate: [44, 'u32'], dwFlag: [48, 'u32'], dwFilePos: [52, 'u32'],
      dwPacketType: [56, 'u32'], dwPacketSize: [60, 'u32'], pPacketBuffer: [64, 'ptr'], byRes1: [72, 'bytes', 4],
      dwPacketMode: [76, 'u32'], byRes2: [80, 'bytes', 16], dwReserved: [96, 'bytes', 24]
    }
  },
  // HCNetSDK.h 11143-11160
  NET_DVR_IPDEVINFO_V31: {
    size: 296, align: 2,
    fields: {
      byEnable: [0, 'u8'], byProType: [1, 'u8'], byEnableQuickAdd: [2, 'u8'], byCameraType: [3, 'u8'], sUserName: [4, 'char', 32],
      sPassword: [36, 'char', 16], byDomain: [52, 'char', 64], struIP: [116, 'bytes', 144], wDVRPort: [260, 'u16'],
      szDeviceID: [262, 'char', 32], byEnableTiming: [294, 'u8'], byCertificateValidation: [295, 'u8']
    }
  },
  // HCNetSDK.h 11173-11182
  NET_DVR_IPCHANINFO: {
    size: 36, align: 1,
    fields: { byEnable: [0, 'u8'], byIPID: [1, 'u8'], byChannel: [2, 'u8'], byIPIDHigh: [3, 'u8'], byTransProtocol: [4, 'u8'], byGetStream: [5, 'u8'], byres: [6, 'bytes', 30] }
  },
  // HCNetSDK.h 11347-11357
  NET_DVR_IPCHANINFO_V40: {
    size: 252, align: 4,
    fields: { byEnable: [0, 'u8'], byRes1: [1, 'u8'], wIPID: [2, 'u16'], dwChannel: [4, 'u32'], byTransProtocol: [8, 'u8'], byTransMode: [9, 'u8'], byFactoryType: [10, 'u8'], byRes: [11, 'u8'], strURL: [12, 'char', 240] }
  },
  // HCNetSDK.h 11399-11408: the largest member is NET_DVR_PU_STREAM_CFG (492 bytes)
  NET_DVR_GET_STREAM_UNION: { size: 492, align: 4, fields: {} },
  // HCNetSDK.h 11423-11430
  NET_DVR_STREAM_MODE: { size: 496, align: 4, fields: { byGetStreamType: [0, 'u8'], byRes: [1, 'bytes', 3], uGetStream: [4, 'bytes', 492] } },
  // HCNetSDK.h 11433-11444
  NET_DVR_IPPARACFG_V40: {
    size: 50792, align: 4,
    fields: {
      dwSize: [0, 'u32'], dwGroupNum: [4, 'u32'], dwAChanNum: [8, 'u32'], dwDChanNum: [12, 'u32'], dwStartDChan: [16, 'u32'],
      byAnalogChanEnable: [20, 'bytes', 64], struIPDevInfo: [84, 'bytes', 296 * 64], struStreamMode: [19028, 'bytes', 496 * 64],
      byRes2: [50772, 'bytes', 20]
    }
  },
  // HCNetSDK.h 49340-49344 (NET_SDK_MAX_FILE_PATH = 256, line 131)
  NET_DVR_LOCAL_SDK_PATH: { size: 384, align: 1, fields: { sPath: [0, 'char', 256], byRes: [256, 'bytes', 128] } },
  // HCNetSDK.h 32081-32091
  NET_SDK_P2P_SERVER_2C: {
    size: 88, align: 8,
    fields: { byPlatformType: [0, 'u8'], byRes1: [1, 'bytes', 3], pAppID: [8, 'ptr'], pAuthAddr: [16, 'ptr'], pPlatformAddr: [24, 'ptr'], pUserName: [32, 'ptr'], pPassword: [40, 'ptr'], byRes: [48, 'bytes', 40] }
  },
  // HCNetSDK.h 32093-32102
  NET_SDK_P2P_SERVER_2B: {
    size: 88, align: 8,
    fields: { byPlatformType: [0, 'u8'], byRes1: [1, 'bytes', 3], pAppID: [8, 'ptr'], pAuthAddr: [16, 'ptr'], pPlatformAddr: [24, 'ptr'], pToken: [32, 'ptr'], byRes: [40, 'bytes', 44] }
  }
}

/**
 * The same structures for koffi, field for field in header order (koffi works the offsets out itself:
 * the tests compare them with LAYOUT). Called with the koffi module; defined once per process. The P2P
 * 2C structure has `const char *` members so a JS object can be passed for the length of one call.
 */
let defined = null
export function defineHikTypes(koffi) {
  if (defined) return defined
  const u8 = (n) => koffi.array('uint8_t', n)
  const ch = (n) => koffi.array('char', n, 'Array')
  const IPADDR = koffi.struct('HIK_NET_DVR_IPADDR', { sIpV4: ch(16), byIPv6: u8(128) })
  const USER_LOGIN_INFO = koffi.struct('HIK_NET_DVR_USER_LOGIN_INFO', {
    sDeviceAddress: ch(129), byUseTransport: 'uint8_t', wPort: 'uint16_t', sUserName: ch(64), sPassword: ch(64),
    cbLoginResult: 'void *', pUser: 'void *', bUseAsynLogin: 'int32_t', byProxyType: 'uint8_t', byUseUTCTime: 'uint8_t',
    byLoginMode: 'uint8_t', byHttps: 'uint8_t', iProxyID: 'int32_t', byVerifyMode: 'uint8_t', byRes1: u8(3),
    cbLoginResultV40: 'void *', byRes3: u8(109)
  })
  const DEVICEINFO_V30 = koffi.struct('HIK_NET_DVR_DEVICEINFO_V30', {
    sSerialNumber: u8(48), byAlarmInPortNum: 'uint8_t', byAlarmOutPortNum: 'uint8_t', byDiskNum: 'uint8_t', byDVRType: 'uint8_t',
    byChanNum: 'uint8_t', byStartChan: 'uint8_t', byAudioChanNum: 'uint8_t', byIPChanNum: 'uint8_t', byZeroChanNum: 'uint8_t',
    byMainProto: 'uint8_t', bySubProto: 'uint8_t', bySupport: 'uint8_t', bySupport1: 'uint8_t', bySupport2: 'uint8_t',
    wDevType: 'uint16_t', bySupport3: 'uint8_t', byMultiStreamProto: 'uint8_t', byStartDChan: 'uint8_t', byStartDTalkChan: 'uint8_t',
    byHighDChanNum: 'uint8_t', bySupport4: 'uint8_t', byLanguageType: 'uint8_t', byVoiceInChanNum: 'uint8_t',
    byStartVoiceInChanNo: 'uint8_t', bySupport5: 'uint8_t', bySupport6: 'uint8_t', byMirrorChanNum: 'uint8_t',
    wStartMirrorChanNo: 'uint16_t', bySupport7: 'uint8_t', byRes2: 'uint8_t'
  })
  const DEVICEINFO_V40 = koffi.struct('HIK_NET_DVR_DEVICEINFO_V40', {
    struDeviceV30: DEVICEINFO_V30, bySupportLock: 'uint8_t', byRetryLoginTime: 'uint8_t', byPasswordLevel: 'uint8_t',
    byProxyType: 'uint8_t', dwSurplusLockTime: 'uint32_t', byCharEncodeType: 'uint8_t', bySupportDev5: 'uint8_t',
    bySupport: 'uint8_t', byLoginMode: 'uint8_t', dwOEMCode: 'uint32_t', iResidualValidity: 'int32_t', byResidualValidity: 'uint8_t',
    bySingleStartDTalkChan: 'uint8_t', bySingleDTalkChanNums: 'uint8_t', byPassWordResetLevel: 'uint8_t',
    bySupportStreamEncrypt: 'uint8_t', byMarketType: 'uint8_t', byTLSCap: 'uint8_t', byChildManage: 'uint8_t',
    byPlaybackNewPosCap: 'uint8_t', bySecondaryAuth: 'uint8_t', byHttpsResult: 'uint8_t', byRes2: u8(233)
  })
  const DEVICECFG_V40 = koffi.struct('HIK_NET_DVR_DEVICECFG_V40', {
    dwSize: 'uint32_t', sDVRName: u8(32), dwDVRID: 'uint32_t', dwRecycleRecord: 'uint32_t', sSerialNumber: u8(48),
    dwSoftwareVersion: 'uint32_t', dwSoftwareBuildDate: 'uint32_t', dwDSPSoftwareVersion: 'uint32_t', dwDSPSoftwareBuildDate: 'uint32_t',
    dwPanelVersion: 'uint32_t', dwHardwareVersion: 'uint32_t', byAlarmInPortNum: 'uint8_t', byAlarmOutPortNum: 'uint8_t',
    byRS232Num: 'uint8_t', byRS485Num: 'uint8_t', byNetworkPortNum: 'uint8_t', byDiskCtrlNum: 'uint8_t', byDiskNum: 'uint8_t',
    byDVRType: 'uint8_t', byChanNum: 'uint8_t', byStartChan: 'uint8_t', byDecordChans: 'uint8_t', byVGANum: 'uint8_t',
    byUSBNum: 'uint8_t', byAuxoutNum: 'uint8_t', byAudioNum: 'uint8_t', byIPChanNum: 'uint8_t', byZeroChanNum: 'uint8_t',
    bySupport: 'uint8_t', byEsataUseage: 'uint8_t', byIPCPlug: 'uint8_t', byStorageMode: 'uint8_t', bySupport1: 'uint8_t',
    wDevType: 'uint16_t', byDevTypeName: u8(24), bySupport2: 'uint8_t', byAnalogAlarmInPortNum: 'uint8_t', byStartAlarmInNo: 'uint8_t',
    byStartAlarmOutNo: 'uint8_t', byStartIPAlarmInNo: 'uint8_t', byStartIPAlarmOutNo: 'uint8_t', byHighIPChanNum: 'uint8_t',
    byEnableRemotePowerOn: 'uint8_t', wDevClass: 'uint16_t', byRes2: u8(6)
  })
  const PREVIEWINFO = koffi.struct('HIK_NET_DVR_PREVIEWINFO', {
    lChannel: 'int32_t', dwStreamType: 'uint32_t', dwLinkMode: 'uint32_t', hPlayWnd: 'uint32_t', bBlocked: 'uint32_t',
    bPassbackRecord: 'uint32_t', byPreviewMode: 'uint8_t', byStreamID: u8(32), byProtoType: 'uint8_t', byRes1: 'uint8_t',
    byVideoCodingType: 'uint8_t', dwDisplayBufNum: 'uint32_t', byNPQMode: 'uint8_t', byRecvMetaData: 'uint8_t',
    byDataType: 'uint8_t', byReconnect: 'uint8_t', byRes: u8(212)
  })
  const PACKET_INFO_EX = koffi.struct('HIK_NET_DVR_PACKET_INFO_EX', {
    wWidth: 'uint16_t', wHeight: 'uint16_t', dwTimeStamp: 'uint32_t', dwTimeStampHigh: 'uint32_t', dwYear: 'uint32_t',
    dwMonth: 'uint32_t', dwDay: 'uint32_t', dwHour: 'uint32_t', dwMinute: 'uint32_t', dwSecond: 'uint32_t',
    dwMillisecond: 'uint32_t', dwFrameNum: 'uint32_t', dwFrameRate: 'uint32_t', dwFlag: 'uint32_t', dwFilePos: 'uint32_t',
    dwPacketType: 'uint32_t', dwPacketSize: 'uint32_t', pPacketBuffer: 'void *', byRes1: u8(4), dwPacketMode: 'uint32_t',
    byRes2: u8(16), dwReserved: koffi.array('uint32_t', 6)
  })
  const IPDEVINFO_V31 = koffi.struct('HIK_NET_DVR_IPDEVINFO_V31', {
    byEnable: 'uint8_t', byProType: 'uint8_t', byEnableQuickAdd: 'uint8_t', byCameraType: 'uint8_t', sUserName: u8(32),
    sPassword: u8(16), byDomain: u8(64), struIP: IPADDR, wDVRPort: 'uint16_t', szDeviceID: u8(32), byEnableTiming: 'uint8_t',
    byCertificateValidation: 'uint8_t'
  })
  const IPCHANINFO = koffi.struct('HIK_NET_DVR_IPCHANINFO', {
    byEnable: 'uint8_t', byIPID: 'uint8_t', byChannel: 'uint8_t', byIPIDHigh: 'uint8_t', byTransProtocol: 'uint8_t', byGetStream: 'uint8_t', byres: u8(30)
  })
  const IPSERVER_STREAM = koffi.struct('HIK_NET_DVR_IPSERVER_STREAM', {
    byEnable: 'uint8_t', byRes: u8(3), struIPServer: IPADDR, wPort: 'uint16_t', wDvrNameLen: 'uint16_t', byDVRName: u8(32),
    wDVRSerialLen: 'uint16_t', byRes1: koffi.array('uint16_t', 2), byDVRSerialNumber: u8(48), byUserName: u8(32), byPassWord: u8(16),
    byChannel: 'uint8_t', byRes2: u8(11)
  })
  const STREAM_MEDIA_SERVER_CFG = koffi.struct('HIK_NET_DVR_STREAM_MEDIA_SERVER_CFG', {
    byValid: 'uint8_t', byRes1: u8(3), struDevIP: IPADDR, wDevPort: 'uint16_t', byTransmitType: 'uint8_t', byRes2: u8(69)
  })
  const DEV_CHAN_INFO = koffi.struct('HIK_NET_DVR_DEV_CHAN_INFO', {
    struIP: IPADDR, wDVRPort: 'uint16_t', byChannel: 'uint8_t', byTransProtocol: 'uint8_t', byTransMode: 'uint8_t',
    byFactoryType: 'uint8_t', byDeviceType: 'uint8_t', byDispChan: 'uint8_t', bySubDispChan: 'uint8_t', byResolution: 'uint8_t',
    byRes: u8(2), byDomain: u8(64), sUserName: u8(32), sPassword: u8(16)
  })
  const PU_STREAM_CFG = koffi.struct('HIK_NET_DVR_PU_STREAM_CFG', { dwSize: 'uint32_t', struStreamMediaSvrCfg: STREAM_MEDIA_SERVER_CFG, struDevChanInfo: DEV_CHAN_INFO })
  const DDNS_STREAM_CFG = koffi.struct('HIK_NET_DVR_DDNS_STREAM_CFG', {
    byEnable: 'uint8_t', byRes1: u8(3), struStreamServer: IPADDR, wStreamServerPort: 'uint16_t', byStreamServerTransmitType: 'uint8_t',
    byRes2: 'uint8_t', struIPServer: IPADDR, wIPServerPort: 'uint16_t', byRes3: u8(2), sDVRName: u8(32), wDVRNameLen: 'uint16_t',
    wDVRSerialLen: 'uint16_t', sDVRSerialNumber: u8(48), sUserName: u8(32), sPassWord: u8(16), wDVRPort: 'uint16_t', byRes4: u8(2),
    byChannel: 'uint8_t', byTransProtocol: 'uint8_t', byTransMode: 'uint8_t', byFactoryType: 'uint8_t'
  })
  const PU_STREAM_URL = koffi.struct('HIK_NET_DVR_PU_STREAM_URL', {
    byEnable: 'uint8_t', strURL: u8(240), byTransPortocol: 'uint8_t', wIPID: 'uint16_t', byChannel: 'uint8_t', byRes: u8(7)
  })
  const HKDDNS_STREAM = koffi.struct('HIK_NET_DVR_HKDDNS_STREAM', {
    byEnable: 'uint8_t', byRes: u8(3), byDDNSDomain: u8(64), wPort: 'uint16_t', wAliasLen: 'uint16_t', byAlias: u8(32),
    wDVRSerialLen: 'uint16_t', byRes1: u8(2), byDVRSerialNumber: u8(48), byUserName: u8(32), byPassWord: u8(16), byChannel: 'uint8_t', byRes2: u8(11)
  })
  const IPCHANINFO_V40 = koffi.struct('HIK_NET_DVR_IPCHANINFO_V40', {
    byEnable: 'uint8_t', byRes1: 'uint8_t', wIPID: 'uint16_t', dwChannel: 'uint32_t', byTransProtocol: 'uint8_t', byTransMode: 'uint8_t',
    byFactoryType: 'uint8_t', byRes: 'uint8_t', strURL: u8(240)
  })
  const GET_STREAM_UNION = koffi.union('HIK_NET_DVR_GET_STREAM_UNION', {
    struChanInfo: IPCHANINFO, struIPServerStream: IPSERVER_STREAM, struPUStream: PU_STREAM_CFG, struDDNSStream: DDNS_STREAM_CFG,
    struStreamUrl: PU_STREAM_URL, struHkDDNSStream: HKDDNS_STREAM, struIPChan: IPCHANINFO_V40
  })
  const STREAM_MODE = koffi.struct('HIK_NET_DVR_STREAM_MODE', { byGetStreamType: 'uint8_t', byRes: u8(3), uGetStream: GET_STREAM_UNION })
  const IPPARACFG_V40 = koffi.struct('HIK_NET_DVR_IPPARACFG_V40', {
    dwSize: 'uint32_t', dwGroupNum: 'uint32_t', dwAChanNum: 'uint32_t', dwDChanNum: 'uint32_t', dwStartDChan: 'uint32_t',
    byAnalogChanEnable: u8(64), struIPDevInfo: koffi.array(IPDEVINFO_V31, 64), struStreamMode: koffi.array(STREAM_MODE, 64), byRes2: u8(20)
  })
  const LOCAL_SDK_PATH = koffi.struct('HIK_NET_DVR_LOCAL_SDK_PATH', { sPath: ch(256), byRes: u8(128) })
  const P2P_SERVER_2C = koffi.struct('HIK_NET_SDK_P2P_SERVER_2C', {
    byPlatformType: 'uint8_t', byRes1: u8(3), pAppID: 'const char *', pAuthAddr: 'const char *', pPlatformAddr: 'const char *',
    pUserName: 'const char *', pPassword: 'const char *', byRes: u8(40)
  })
  const P2P_SERVER_2B = koffi.struct('HIK_NET_SDK_P2P_SERVER_2B', {
    byPlatformType: 'uint8_t', byRes1: u8(3), pAppID: 'const char *', pAuthAddr: 'const char *', pPlatformAddr: 'const char *',
    pToken: 'const char *', byRes: u8(44)
  })
  defined = {
    NET_DVR_IPADDR: IPADDR, NET_DVR_USER_LOGIN_INFO: USER_LOGIN_INFO, NET_DVR_DEVICEINFO_V30: DEVICEINFO_V30,
    NET_DVR_DEVICEINFO_V40: DEVICEINFO_V40, NET_DVR_DEVICECFG_V40: DEVICECFG_V40, NET_DVR_PREVIEWINFO: PREVIEWINFO, NET_DVR_PACKET_INFO_EX: PACKET_INFO_EX,
    NET_DVR_IPDEVINFO_V31: IPDEVINFO_V31, NET_DVR_IPCHANINFO: IPCHANINFO, NET_DVR_IPCHANINFO_V40: IPCHANINFO_V40,
    NET_DVR_GET_STREAM_UNION: GET_STREAM_UNION, NET_DVR_STREAM_MODE: STREAM_MODE, NET_DVR_IPPARACFG_V40: IPPARACFG_V40,
    NET_DVR_LOCAL_SDK_PATH: LOCAL_SDK_PATH, NET_SDK_P2P_SERVER_2C: P2P_SERVER_2C, NET_SDK_P2P_SERVER_2B: P2P_SERVER_2B
  }
  return defined
}

/**
 * Every LAYOUT size and offset that koffi disagrees with, as lines ([] = all agree). hik-sdk.mjs runs it
 * before the library is used: a mismatch there stops the Hikvision worker instead of reading garbage.
 */
export function layoutMismatches(koffi, types = defineHikTypes(koffi)) {
  const out = []
  for (const [name, l] of Object.entries(LAYOUT)) {
    const t = types[name]
    if (!t) {
      out.push(`${name}: no koffi type`)
      continue
    }
    if (koffi.sizeof(t) !== l.size) out.push(`${name}: size ${koffi.sizeof(t)}, expected ${l.size}`)
    if (koffi.alignof(t) !== l.align) out.push(`${name}: alignment ${koffi.alignof(t)}, expected ${l.align}`)
    for (const [f, [off]] of Object.entries(l.fields)) {
      let got
      try {
        got = koffi.offsetof(t, f)
      } catch (e) {
        out.push(`${name}.${f}: ${e.message}`)
        continue
      }
      if (got !== off) out.push(`${name}.${f}: offset ${got}, expected ${off}`)
    }
  }
  return out
}

// ---- reading and writing Buffers at LAYOUT offsets ------------------------------------------------

const fieldOf = (struct, field) => {
  const f = LAYOUT[struct]?.fields[field]
  if (!f) throw new Error(`${struct}.${field} is not in LAYOUT`)
  return f
}

/** A zeroed Buffer the size of the structure. */
export const alloc = (struct) => Buffer.alloc(LAYOUT[struct].size)

/** Reads one field (numbers, or a string for char fields, a Buffer copy for bytes) at base + its offset. */
export function readField(buf, struct, field, base = 0) {
  const [off, kind, n] = fieldOf(struct, field)
  const at = base + off
  switch (kind) {
    case 'u8': return buf.readUInt8(at)
    case 'u16': return buf.readUInt16LE(at)
    case 'u32': return buf.readUInt32LE(at)
    case 'i32': return buf.readInt32LE(at)
    case 'ptr': return buf.readBigUInt64LE(at)
    case 'char': {
      const raw = buf.subarray(at, at + n)
      const end = raw.indexOf(0)
      return raw.subarray(0, end < 0 ? n : end).toString('latin1')
    }
    default: return Buffer.from(buf.subarray(at, at + n))
  }
}

/** Writes one number or string field; a string longer than the field (less its NUL) throws. */
export function writeField(buf, struct, field, value, base = 0) {
  const [off, kind, n] = fieldOf(struct, field)
  const at = base + off
  switch (kind) {
    case 'u8': return void buf.writeUInt8(value, at)
    case 'u16': return void buf.writeUInt16LE(value, at)
    case 'u32': return void buf.writeUInt32LE(value >>> 0, at)
    case 'i32': return void buf.writeInt32LE(value, at)
    case 'char': {
      const bytes = Buffer.from(String(value), 'utf8')
      if (bytes.length > n - 1) throw new Error(`${field} is too long (at most ${n - 1} bytes)`)
      buf.fill(0, at, at + n)
      bytes.copy(buf, at)
      return
    }
    default: throw new Error(`${struct}.${field} (${kind}) cannot be written here`)
  }
}
